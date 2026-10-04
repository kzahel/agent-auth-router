//! Debug-only native WebView smoke. The runner supplies an isolated synthetic state.
use serde_json::{json, Value};
pub fn enabled() -> bool {
    (std::env::var("AAR_SIGNIN_SMOKE").as_deref() == Ok("1")
        || std::env::var("AAR_LIFECYCLE_SMOKE").as_deref() == Ok("1"))
        && std::env::var_os("AAR_STATE_DIR").is_some_and(|path| {
            std::fs::read_to_string(std::path::PathBuf::from(path).join("synthetic-signin"))
                .is_ok_and(|value| value == "synthetic-only")
        })
}
#[tauri::command]
pub fn smoke_result(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    ok: bool,
) -> Result<(), String> {
    if !enabled() {
        return Err("Smoke unavailable".into());
    }
    let result: Value = json!({"ok":ok,"window":window.label()});
    std::fs::write(
        super::state_dir(&app)?.join("embedded-smoke.json"),
        result.to_string(),
    )
    .map_err(|_| "Cannot record smoke")?;
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}
#[tauri::command]
pub fn smoke_window(window: tauri::WebviewWindow, close: bool) -> Result<bool, String> {
    if !enabled() || window.label() != "main" {
        return Err("Smoke unavailable".into());
    }
    if close {
        window.close().map_err(|_| "Cannot close window")?;
    }
    window
        .is_visible()
        .map_err(|_| "Cannot inspect window".into())
}
#[tauri::command]
pub fn smoke_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if !enabled() || window.label() != "main" {
        return Err("Smoke unavailable".into());
    }
    std::fs::write(super::state_dir(&app)?.join("pairing-ready"), "ready")
        .map_err(|_| "Cannot record readiness".into())
}
pub fn loaded(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if !enabled() || payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    let script = if std::env::var("AAR_PAIRING_SMOKE").as_deref() == Ok("1") {
        r#"(async()=>{
          const invoke=window.__TAURI__.core.invoke;
          const wait=async(check)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,50));}throw Error();};
          try {
            await wait(()=>document.querySelector('#integrations')?.textContent.includes('No connections.'));
            await invoke('smoke_ready');
            // The runner pairs externally after our initial view is rendered.
            await wait(()=>document.querySelector('#integrations')?.textContent.includes('Synthetic YA'));
            const status=await invoke('router',{operation:'observe',body:{}});
            await invoke('router',{operation:'stop',body:{routerId:status.routerId}});
            await new Promise(r=>setTimeout(r,300));
            let refused=false;try{await invoke('router',{operation:'observe',body:{}});}catch{refused=true;}
            if(!refused)throw Error();
            await invoke('smoke_result',{ok:true});
          } catch { await invoke('smoke_result',{ok:false}); }
        })()"#
    } else if std::env::var("AAR_LIFECYCLE_SMOKE").as_deref() == Ok("1") {
        r#"(async()=>{
          const invoke=window.__TAURI__.core.invoke;
          try {
            const first=await invoke('router',{operation:'overview',body:{}});
            await invoke('smoke_window',{close:true});
            let hidden=false;
            for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,50));if(!await invoke('smoke_window',{close:false})){hidden=true;break;}}
            if(!hidden) throw Error();
            const second=await invoke('router',{operation:'overview',body:{}});
            if(first.routerId!==second.routerId) throw Error();
            await invoke('smoke_result',{ok:true});
          } catch { await invoke('smoke_result',{ok:false}); }
        })()"#
    } else if webview.label() == "main" {
        r#"(async()=>{
          const invoke=window.__TAURI__.core.invoke;
          try {
            await invoke('router',{operation:'overview',body:{}});
            let denied=false; try { await invoke('terminal',{action:'read'}); } catch { denied=true; }
            if(!denied) throw Error();
            await invoke('router',{operation:'accounts/add',body:{id:'smoke-codex',provider:'codex'}});
            await invoke('router',{operation:'accounts/terminal-login',body:{id:'smoke-codex',presentation:'embedded'}});
          } catch { await invoke('smoke_result',{ok:false}); }
        })()"#
    } else {
        r#"(async()=>{
          const invoke=window.__TAURI__.core.invoke;
          const wait=async(check)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,50));}throw Error();};
          try {
            await wait(()=>document.querySelector('.xterm-rows')?.textContent.includes('Choose [1/2]'));
            let denied=false; try { await invoke('router',{operation:'overview',body:{}}); } catch { denied=true; }
            if(!denied) throw Error();
            await invoke('terminal',{action:'write',data:'2\r'});
            await wait(()=>document.querySelector('.xterm-rows')?.textContent.includes('SYNTHETIC_CONFIRM'));
            await invoke('terminal',{action:'write',data:'yes\r'});
            await wait(()=>document.querySelector('#terminal-status')?.textContent.startsWith('Command finished'));
            await invoke('smoke_result',{ok:true});
          } catch { await invoke('smoke_result',{ok:false}); }
        })()"#
    };
    let _ = webview.eval(script);
}
