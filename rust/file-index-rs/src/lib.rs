//! JS bindings for `rayu/src/native-ts/file-index/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod utf16;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

#[allow(dead_code)]
async fn run_async<T>(f: impl std::future::Future<Output = Result<T, String>>) -> napi::Result<T> {
    use futures::FutureExt as _;
    match std::panic::AssertUnwindSafe(f).catch_unwind().await {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

/// `yieldToEventLoop`.
#[napi(js_name = "yieldToEventLoop")]
pub async fn yield_to_event_loop() -> napi::Result<()> {
    run_async(async move {
        port::yield_to_event_loop().await?;
        Ok(())
    })
    .await
}

/// Class `FileIndex`.
#[napi(js_name = "FileIndex")]
pub struct FileIndex {
    inner: port::FileIndex,
}

#[napi]
impl FileIndex {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        run(move || {
            let out = port::FileIndex::new()?;
            Ok(Self { inner: out })
        })
    }

    #[napi(js_name = "loadFromFileList")]
    pub fn load_from_file_list(&mut self, file_list: Vec<String>) -> napi::Result<()> {
        let inner = &mut self.inner;
        run(move || {
            inner.load_from_file_list(file_list)?;
            Ok(())
        })
    }

    #[napi(js_name = "loadFromFileListAsync")]
    pub fn load_from_file_list_async(&mut self, file_list: Vec<String>) -> napi::Result<String> {
        let inner = &mut self.inner;
        run(move || {
            let out = inner.load_from_file_list_async(file_list)?;
            crate::js::to_json(&out)
        })
    }

    #[napi(js_name = "search")]
    pub fn search(&mut self, query: String, limit: f64) -> napi::Result<String> {
        let inner = &mut self.inner;
        run(move || {
            let out = inner.search(query, limit)?;
            crate::js::to_json(&out)
        })
    }
}
