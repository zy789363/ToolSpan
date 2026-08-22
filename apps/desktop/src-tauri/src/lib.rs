pub mod config;
pub mod node;
pub mod password;
pub mod process;
pub mod protocol;
pub mod public_endpoint;
pub mod setup;

pub fn run() {
    app::run();
}

mod app;
mod commands;
