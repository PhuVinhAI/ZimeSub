mod ass_ops;
mod commands;
mod duration_probe;
mod encoder_probe;
mod episode_state;
mod install;
mod job_queue;
mod logging;
mod mkv_probe;
mod paths;
mod process_runner;
mod progress_parsers;
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
            commands::project_add_episodes,
            commands::episode_list_subtitle_tracks,
            commands::project_set_selected_track,
            commands::episode_inspect_artifacts,
            commands::extract_subtitle_start,
            commands::extract_subtitle_cancel,
            commands::extract_audio_start,
            commands::extract_audio_cancel,
            commands::project_get_extract_audio_config,
            commands::project_set_extract_audio_config,
            commands::episode_open_folder,
            commands::episode_make_translation_draft,
            commands::episode_write_translated,
            commands::episode_style_patch,
            commands::job_snapshot,
            commands::job_cancel,
            commands::job_remove_pending,
            commands::settings_get_queue_concurrency,
            commands::settings_set_queue_concurrency,
            commands::encoder_probe_get_cached,
            commands::encoder_probe_rescan,
            commands::project_get_render_config,
            commands::project_set_render_config,
            commands::episode_get_effective_render_config,
            commands::episode_set_render_config_override,
            commands::render_start,
            commands::render_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
