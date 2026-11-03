#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        light_pen_lib::run_mcp()
    } else {
        light_pen_lib::run()
    }
}
