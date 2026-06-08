mod commands;
mod install;
mod logging;
mod paths;
mod project_store;
mod settings_store;
mod tooling;

use tracing::{info, warn};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(err) = logging::init() {
        // The log file itself failed to come up — fall back to stderr so the
        // user (or a dev tail-ing the console) still sees the startup error.
        eprintln!("ZimeSub: failed to initialise log file: {err}");
    }
    info!("ZimeSub starting (v{})", env!("CARGO_PKG_VERSION"));
    if paths::app_data_dir().is_none() {
        warn!("Roaming AppData directory not available; settings + logs will not persist");
    }

    let mut builder = tauri::Builder::default();

    #[cfg(debug_assertions)]
    {
        let devtools = tauri_plugin_devtools::init();
        builder = builder.plugin(devtools);
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::tool_probe,
            commands::tool_rescan,
            commands::winget_available,
            commands::tool_install_start,
            commands::tool_install_cancel,
            commands::project_inspect_folder,
            commands::project_create,
            commands::project_open,
            commands::project_list_recents,
            commands::project_remove_recent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
