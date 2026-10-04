//! Debug-only native WebView smoke. The runner supplies an isolated synthetic state.
use serde_json::{json, Value};
pub fn enabled() -> bool {
    std::env::var("AAR_SIGNIN_SMOKE").as_deref() == Ok("1")
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
pub fn loaded(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if !enabled() || payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    let script = if webview.label() == "main" {
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
