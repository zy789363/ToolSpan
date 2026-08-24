use std::sync::Arc;

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use crate::commands::{DesktopPaths, DesktopState, tray_request_id};
use crate::process::{FIXED_HOST_RESOURCE, HostReply};
use crate::protocol::DesktopRequest;

const TRAY_RUNNING_PNG: &[u8] = include_bytes!("../icons/tray-running.png");
const TRAY_STOPPED_PNG: &[u8] = include_bytes!("../icons/tray-stopped.png");
const TRAY_ATTENTION_PNG: &[u8] = include_bytes!("../icons/tray-attention.png");

fn status_text(key: &str) -> &'static str {
    match key {
        "running" => "ToolSpan — Running",
        "stopped" => "ToolSpan — Stopped",
        _ => "ToolSpan — Attention",
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            crate::commands::desktop_invoke,
            crate::commands::hash_owner_password,
            crate::commands::pick_allowed_root,
            crate::commands::remove_allowed_root,
            crate::commands::complete_first_run,
            crate::commands::update_owner_password_hash,
            crate::commands::choose_node_executable,
            crate::commands::confirm_quit,
            crate::setup::setup_set_credential
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_safe_quit(window.app_handle());
            }
        })
        .setup(|app| {
            let app_config = app.path().app_config_dir()?;
            let app_data = app.path().app_data_dir()?;
            let app_logs = app.path().app_log_dir()?;
            let resource = app
                .path()
                .resolve(FIXED_HOST_RESOURCE, BaseDirectory::Resource)?;
            let state = DesktopState::new(
                DesktopPaths {
                    config_file: app_config.join("toolspan.config.json"),
                    password_file: app_config.join("secrets").join("owner.bcrypt"),
                    node_settings_file: app_config.join("desktop-node.json"),
                    app_data_root: app_data,
                    app_log_root: app_logs,
                },
                resource,
            )
            .map_err(|_| std::io::Error::other("desktop state initialization failed"))?;
            app.manage(state);
            build_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("ToolSpan desktop failed to initialize");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let managed = app
                .state::<DesktopState>()
                .supervisor
                .lock()
                .ok()
                .is_some_and(|supervisor| supervisor.ownership_nonce().is_some());
            if managed {
                api.prevent_exit();
                request_safe_quit(app);
            }
        }
    });
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "ToolSpan — Stopped", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop", false, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy-mcp-url", "Copy MCP URL", false, None::<&str>)?;
    let open_logs = MenuItem::with_id(app, "open-logs", "Open logs", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&status)
        .separator()
        .item(&show)
        .separator()
        .item(&start)
        .item(&restart)
        .item(&stop)
        .separator()
        .item(&copy)
        .item(&open_logs)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("toolspan-main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "start" => run_tray_runtime(app, "runtime.start", "running"),
            "restart" => run_tray_runtime(app, "runtime.restart", "running"),
            "stop" => run_tray_runtime(app, "runtime.stop", "stopped"),
            "copy-mcp-url" => {
                let _ = app.emit("tray://copy-mcp-url", ());
            }
            "open-logs" => {
                show_main_window(app);
                let _ = app.emit("tray://open-logs", ());
            }
            "quit" => request_safe_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Ok(icon) = Image::from_bytes(TRAY_STOPPED_PNG) {
        builder = builder.icon(icon);
    }
    let tray_icon = builder.build(app)?;
    app.manage(TrayStatus {
        status_item: status,
        start_item: start,
        restart_item: restart,
        stop_item: stop,
        copy_item: copy,
        tray_icon,
    });
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn run_tray_runtime(app: &tauri::AppHandle, method: &'static str, success_key: &'static str) {
    let supervisor = Arc::clone(&app.state::<DesktopState>().supervisor);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let request = DesktopRequest {
                id: tray_request_id(method),
                method: method.into(),
                params: json!({}),
            };
            supervisor.lock().ok()?.invoke(&request).ok()
        })
        .await
        .ok()
        .flatten();
        let (status, ok) = tray_runtime_result(result.as_ref(), success_key);
        update_tray_status(&app, if ok { success_key } else { "attention" });
        let _ = app.emit(
            "tray://runtime-result",
            json!({"method": method, "status": status, "ok": ok}),
        );
    });
}

fn tray_runtime_result(
    reply: Option<&HostReply>,
    success_key: &'static str,
) -> (&'static str, bool) {
    let ok = reply.is_some_and(|reply| {
        reply.response.get("ok").and_then(|value| value.as_bool()) == Some(true)
    });
    if ok {
        (status_text(success_key), true)
    } else {
        ("ToolSpan — Attention", false)
    }
}

fn request_safe_quit(app: &tauri::AppHandle) {
    let managed = app
        .state::<DesktopState>()
        .supervisor
        .lock()
        .ok()
        .is_some_and(|supervisor| supervisor.ownership_nonce().is_some());
    if managed {
        show_main_window(app);
        let _ = app.emit("tray://quit-requested", json!({"managedCore": true}));
    } else {
        app.exit(0);
    }
}

struct TrayStatus {
    status_item: MenuItem<tauri::Wry>,
    start_item: MenuItem<tauri::Wry>,
    restart_item: MenuItem<tauri::Wry>,
    stop_item: MenuItem<tauri::Wry>,
    copy_item: MenuItem<tauri::Wry>,
    tray_icon: TrayIcon,
}

pub(crate) fn update_tray_status(app: &tauri::AppHandle, status: &str) {
    if let Some(state) = app.try_state::<TrayStatus>() {
        let running = status == "running";
        let icon = match status {
            "running" => TRAY_RUNNING_PNG,
            "attention" => TRAY_ATTENTION_PNG,
            _ => TRAY_STOPPED_PNG,
        };
        let _ = state.status_item.set_text(status_text(status));
        let _ = state.start_item.set_enabled(!running);
        let _ = state.restart_item.set_enabled(running);
        let _ = state.stop_item.set_enabled(running);
        let _ = state.copy_item.set_enabled(running);
        if let Ok(image) = Image::from_bytes(icon) {
            let _ = state.tray_icon.set_icon(Some(image));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::HostReply;

    #[test]
    fn tray_runtime_requires_an_explicitly_successful_host_reply() {
        let success = HostReply {
            response: json!({"id": "tray-success", "ok": true, "result": {}}),
            events: Vec::new(),
        };
        let failure = HostReply {
            response: json!({
                "id": "tray-failure",
                "ok": false,
                "error": {"code": "SERVICE_ERROR", "message": "private-marker"}
            }),
            events: Vec::new(),
        };
        let malformed = HostReply {
            response: json!({"id": "tray-malformed"}),
            events: Vec::new(),
        };

        assert_eq!(
            tray_runtime_result(Some(&success), "running"),
            ("ToolSpan — Running", true)
        );
        assert_eq!(
            tray_runtime_result(Some(&failure), "running"),
            ("ToolSpan — Attention", false)
        );
        assert_eq!(
            tray_runtime_result(Some(&malformed), "stopped"),
            ("ToolSpan — Attention", false)
        );
        assert_eq!(
            tray_runtime_result(None, "stopped"),
            ("ToolSpan — Attention", false)
        );
    }

    #[test]
    fn managed_quit_has_one_renderer_confirmation_surface() {
        let source = include_str!("app.rs");
        let start = source
            .find("fn request_safe_quit")
            .expect("safe quit function");
        let remainder = &source[start..];
        let end = remainder
            .find("\n}\n\nstruct TrayStatus")
            .expect("safe quit function boundary");
        let body = &remainder[..end];

        assert_eq!(body.matches("tray://quit-requested").count(), 1);
        assert!(!body.contains(".dialog()"));
        assert!(!body.contains("MessageDialogButtons"));
        assert!(body.contains("app.exit(0)"));
    }

    #[test]
    fn main_window_close_is_intercepted_before_safe_quit() {
        let source = include_str!("app.rs");
        let handler = source
            .split_once(".on_window_event(|window, event| {")
            .expect("window event handler")
            .1
            .split_once("\n        .setup")
            .expect("window event handler boundary")
            .0;

        assert!(handler.contains(r#"window.label() != "main""#));
        let close = handler
            .split_once("WindowEvent::CloseRequested { api, .. }")
            .expect("main close request branch")
            .1;
        let prevent = close.find("api.prevent_close()").expect("prevent close");
        let request = close
            .find("request_safe_quit(window.app_handle())")
            .expect("safe quit request");

        assert!(prevent < request);
        assert!(!handler.contains("window.close("));
        assert!(!handler.contains("window.destroy("));
        assert!(!handler.contains("app.exit("));
    }
}
