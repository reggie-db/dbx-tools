use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use dbx_tools_core::{FileCache, FileCacheError, FileLock, FileLockError};

#[tokio::test]
async fn concurrent_loaders_share_the_file_cache() {
    let directory = tempfile::tempdir().unwrap();
    let cache = FileCache::new(directory.path().join("value.json"), Duration::from_secs(60));
    let loads = Arc::new(AtomicUsize::new(0));

    let load = |cache: FileCache, loads: Arc<AtomicUsize>| async move {
        cache
            .get_or_try_init::<String, TestError, _, _>(|| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok("cached".to_owned())
            })
            .await
    };
    let (first, second) = tokio::join!(
        load(cache.clone(), Arc::clone(&loads)),
        load(cache, Arc::clone(&loads))
    );

    assert_eq!(first.unwrap(), "cached");
    assert_eq!(second.unwrap(), "cached");
    assert_eq!(loads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn file_lock_times_out_while_another_holder_is_active() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.lock");
    let _first = FileLock::acquire(&path, Duration::from_secs(1))
        .await
        .unwrap();

    let second = FileLock::acquire(path, Duration::from_millis(25)).await;

    assert!(matches!(second, Err(FileLockError::LockTimeout(_))));
}

#[derive(Debug, thiserror::Error)]
enum TestError {
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    #[error(transparent)]
    Load(#[from] Infallible),
}
