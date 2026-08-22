use std::sync::Arc;

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use crate::commands::{DesktopPaths, DesktopState, tray_request_id};
use crate::process::{FIXED_HOST_RESOURCE, HostReply};
use crate::protocol::DesktopRequest;

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
    let menu = MenuBuilder::new(app)
        .item(&status)
        .separator()
        .text("show", "Show")
        .text("start", "Start")
        .text("restart", "Restart")
        .text("stop", "Stop")
        .separator()
        .text("copy-mcp-url", "Copy MCP URL")
        .text("open-logs", "Open logs")
        .separator()
        .text("quit", "Quit")
        .build()?;
    app.manage(TrayStatus {
        item: status.clone(),
    });

    let status_for_menu = status.clone();
    let mut builder = TrayIconBuilder::with_id("toolspan-main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "start" => run_tray_runtime(
                app,
                "runtime.start",
                "ToolSpan — Running",
                status_for_menu.clone(),
            ),
            "restart" => run_tray_runtime(
                app,
                "runtime.restart",
                "ToolSpan — Running",
                status_for_menu.clone(),
            ),
            "stop" => run_tray_runtime(
                app,
                "runtime.stop",
                "ToolSpan — Stopped",
                status_for_menu.clone(),
            ),
            "copy-mcp-url" => {
                let _ = app.emit("tray://copy-mcp-url", ());
            }
            "open-logs" => {
                show_main_window(app);
                let _ = app.emit("tray://open-logs", ());
            }
            "quit" => request_safe_quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn run_tray_runtime(
    app: &tauri::AppHandle,
    method: &'static str,
    success_status: &'static str,
    status_item: MenuItem<tauri::Wry>,
) {
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
        let (status, ok) = tray_runtime_result(result.as_ref(), success_status);
        let _ = status_item.set_text(status);
        let _ = app.emit(
            "tray://runtime-result",
            json!({"method": method, "status": status, "ok": ok}),
        );
    });
}

fn tray_runtime_result(
    reply: Option<&HostReply>,
    success_status: &'static str,
) -> (&'static str, bool) {
    let ok = reply.is_some_and(|reply| {
        reply.response.get("ok").and_then(|value| value.as_bool()) == Some(true)
    });
    if ok {
        (success_status, true)
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
    item: MenuItem<tauri::Wry>,
}

pub(crate) fn update_tray_status(app: &tauri::AppHandle, status: &str) {
    if let Some(state) = app.try_state::<TrayStatus>() {
        let _ = state.item.set_text(status);
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
            tray_runtime_result(Some(&success), "ToolSpan — Running"),
            ("ToolSpan — Running", true)
        );
        assert_eq!(
            tray_runtime_result(Some(&failure), "ToolSpan — Running"),
            ("ToolSpan — Attention", false)
        );
        assert_eq!(
            tray_runtime_result(Some(&malformed), "ToolSpan — Stopped"),
            ("ToolSpan — Attention", false)
        );
        assert_eq!(
            tray_runtime_result(None, "ToolSpan — Stopped"),
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
