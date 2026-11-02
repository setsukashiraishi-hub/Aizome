mod ai;
mod clipwatch;
mod extensions;
mod fsops;
mod git;
mod local_ai;
mod os_integration;
mod preview;
mod pty;
mod runtimes;
mod encoding;
mod search;
mod tools;
mod updater;

use serde::Serialize;
use tauri::Manager;

/// 文字ではないファイル（Word の .docx など）を書く。中身は base64 で受け取る
#[tauri::command(async)]
fn fsops_extra_write_base64(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SysInfo {
    os: String,
    home: String,
    default_shell: String,
    path_sep: String,
}

#[tauri::command(async)]
fn sys_info() -> SysInfo {
    SysInfo {
        os: std::env::consts::OS.to_string(),
        home: fsops::home_dir(),
        default_shell: pty::default_shell(),
        path_sep: std::path::MAIN_SEPARATOR.to_string(),
    }
}

/// 開いているページを印刷する（OS の印刷ダイアログを出す）
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    tauri: String,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tauri: tauri::VERSION.to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 更新係として起動されたときは、入れ替えだけして終わる
    if updater::run_helper_if_requested() {
        return;
    }

    let builder = tauri::Builder::default();
    // すでに Aizome が開いていれば、新しく開かずにそちらにファイルを渡す
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let paths = os_integration::paths_from_args(&argv, std::path::Path::new(&cwd));
        if paths.is_empty() {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        } else {
            os_integration::deliver(app, paths);
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(os_integration::OpenRequests::default())
        .setup(|app| {
            // 「プログラムから開く」などで渡されたファイル
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = os_integration::paths_from_args(&args, &cwd);
            os_integration::deliver(app.handle(), paths);
            // 右クリックメニューと「プログラムから開く」に登録（Windows・初回のみ）
            os_integration::auto_register(app.handle());
            // コピー履歴のためにクリップボードを見張る
            clipwatch::start(app.handle().clone());
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(preview::PreviewState::default())
        .register_uri_scheme_protocol("aizpv", preview::handle)
        .manage(ai::AiState::new())
        .manage(local_ai::LocalAiState::default())
        .invoke_handler(tauri::generate_handler![
            encoding::fs_read_file_enc,
            encoding::fs_write_file_enc,
            runtimes::find_python,
            runtimes::list_pythons,
            tools::find_tool,
            tools::run_capture,
            fsops_extra_write_base64,
            sys_info,
            print_page,
            app_info,
            fsops::fs_list_dir,
            fsops::fs_walk,
            fsops::fs_read_file,
            fsops::fs_write_file,
            fsops::fs_create_file,
            fsops::fs_create_dir,
            fsops::fs_rename,
            fsops::fs_remove,
            fsops::fs_exists,
            fsops::fs_is_dir,
            fsops::fs_read_data_url,
            search::fs_search,
            git::git_status,
            pty::pty_spawn,
            pty::pty_shells,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            ai::ai_complete,
            ai::ai_cancel,
            ai::ai_models,
            ai::ai_diagnose,
            local_ai::ai_autodetect,
            local_ai::ai_use_models_dir,
            local_ai::ai_import_gguf,
            updater::update_check,
            os_integration::take_open_paths,
            os_integration::os_integration_status,
            os_integration::os_integration_set,
            os_integration::os_default_apps,
            os_integration::os_open_with,
            preview::preview_set,
            preview::preview_open_external,
            updater::update_install,
            extensions::ext_dir,
            extensions::ext_list,
            extensions::ext_install,
            extensions::ext_uninstall,
        ])
        .build(tauri::generate_context!())
        .expect("Aizome の起動に失敗しました")
        .run(|app, event| {
            match event {
                // 自分で起動した Ollama は、アプリを閉じるときに止める
                tauri::RunEvent::Exit => app.state::<local_ai::LocalAiState>().shutdown(),
                // Mac：Finder の「このアプリで開く」から渡されたファイル
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().to_string()).collect();
                    os_integration::deliver(app, paths);
                }
                _ => {}
            }
        });
}
