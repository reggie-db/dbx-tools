//! Typed process-local topics with optional retained state and SQLite replay.

use std::{
    collections::VecDeque,
    num::NonZeroUsize,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use futures::Stream;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{Result, ServiceStorage};

/// Retained state available to queries and new subscribers.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TopicRetention {
    /// Deliver only to current subscribers.
    #[default]
    None,
    /// Retain the latest event.
    Latest,
    /// Retain a bounded event history.
    Replay(NonZeroUsize),
}

impl TopicRetention {
    fn capacity(self) -> usize {
        match self {
            Self::None => 0,
            Self::Latest => 1,
            Self::Replay(capacity) => capacity.get(),
        }
    }
}

/// Topic retention and persistence policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TopicOptions {
    /// In-memory state retained for queries and replay.
    pub retention: TopicRetention,
    /// Persist retained state when the service runtime provides SQLite storage.
    pub stored: bool,
    /// Live subscriber buffer before lag recovery applies.
    pub channel_capacity: NonZeroUsize,
}

impl Default for TopicOptions {
    fn default() -> Self {
        Self {
            retention: TopicRetention::None,
            stored: false,
            channel_capacity: NonZeroUsize::new(64).expect("topic capacity is non-zero"),
        }
    }
}

impl TopicOptions {
    /// A live-only topic that does no work without subscribers.
    pub fn live() -> Self {
        Self::default()
    }

    /// A topic retaining its latest event.
    pub fn latest(stored: bool) -> Self {
        Self {
            retention: TopicRetention::Latest,
            stored,
            ..Self::default()
        }
    }

    /// A topic retaining up to `capacity` events.
    pub fn replay(capacity: NonZeroUsize, stored: bool) -> Self {
        Self {
            retention: TopicRetention::Replay(capacity),
            stored,
            channel_capacity: capacity.max(Self::default().channel_capacity),
        }
    }
}

/// One sequenced event delivered by a topic.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicEvent<T> {
    /// Monotonic sequence within this topic and storage scope.
    pub sequence: u64,
    /// Wall-clock publication time in Unix milliseconds.
    pub published_at_ms: u64,
    /// Consumer-owned typed payload.
    pub payload: T,
}

/// Shared persistence context used to construct typed topics.
#[derive(Clone)]
pub struct TopicContext {
    storage: Option<ServiceStorage>,
    scope: Arc<str>,
}

impl TopicContext {
    /// Construct a topic context for one stable non-secret service scope.
    pub fn new(storage: Option<ServiceStorage>, scope: impl Into<String>) -> Result<Self> {
        let scope = scope.into();
        validate_topic_key(&scope, "topic scope")?;
        Ok(Self {
            storage,
            scope: Arc::from(scope),
        })
    }

    /// Construct one typed topic with consumer-owned payloads.
    pub fn topic<T>(&self, name: impl Into<String>, options: TopicOptions) -> Result<Topic<T>>
    where
        T: Clone + DeserializeOwned + Send + Serialize + Sync + 'static,
    {
        Topic::new(self.clone(), name.into(), options)
    }
}

struct TopicInner<T> {
    name: String,
    context: TopicContext,
    options: TopicOptions,
    next_sequence: AtomicU64,
    retained: Mutex<VecDeque<TopicEvent<T>>>,
    sender: broadcast::Sender<TopicEvent<T>>,
}

/// Typed live feed with optional latest-state or replay retention.
#[derive(Clone)]
pub struct Topic<T> {
    inner: Arc<TopicInner<T>>,
}

impl<T> Topic<T>
where
    T: Clone + DeserializeOwned + Send + Serialize + Sync + 'static,
{
    fn new(context: TopicContext, name: String, options: TopicOptions) -> Result<Self> {
        validate_topic_key(&name, "topic name")?;
        if options.stored && options.retention == TopicRetention::None {
            return Err("stored topics require latest or replay retention".into());
        }
        let capacity = options.retention.capacity();
        let (retained, next_sequence) = if options.stored {
            if let Some(storage) = context.storage.as_ref() {
                let stored = storage.load_topic_events(&context.scope, &name, capacity)?;
                let next_sequence = stored
                    .back()
                    .map_or(1, |event| event.sequence.saturating_add(1));
                let retained = stored
                    .into_iter()
                    .filter_map(|event| match serde_json::from_slice(&event.payload) {
                        Ok(payload) => Some(TopicEvent {
                            sequence: event.sequence,
                            published_at_ms: event.published_at_ms,
                            payload,
                        }),
                        Err(error) => {
                            tracing::warn!(
                                topic = name,
                                sequence = event.sequence,
                                %error,
                                "stored topic event could not be restored"
                            );
                            None
                        }
                    })
                    .collect();
                (retained, next_sequence)
            } else {
                (VecDeque::new(), 1)
            }
        } else {
            (VecDeque::new(), 1)
        };
        let (sender, _) = broadcast::channel(options.channel_capacity.get());
        Ok(Self {
            inner: Arc::new(TopicInner {
                name,
                context,
                options,
                next_sequence: AtomicU64::new(next_sequence),
                retained: Mutex::new(retained),
                sender,
            }),
        })
    }

    /// Whether publication has a current subscriber or retained-state consumer.
    pub fn is_active(&self) -> bool {
        self.inner.sender.receiver_count() > 0 || self.inner.options.retention.capacity() > 0
    }

    /// Number of current live subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.inner.sender.receiver_count()
    }

    /// Publish when the topic has live or retained-state demand.
    ///
    /// A live-only topic with no subscribers returns `Ok(None)` before
    /// allocating an envelope or serializing the payload.
    pub fn publish(&self, payload: T) -> Result<Option<TopicEvent<T>>> {
        if !self.is_active() {
            return Ok(None);
        }
        let event = TopicEvent {
            sequence: self.inner.next_sequence.fetch_add(1, Ordering::Relaxed),
            published_at_ms: wall_clock_ms(),
            payload,
        };
        let capacity = self.inner.options.retention.capacity();
        if capacity > 0 {
            let mut retained = self
                .inner
                .retained
                .lock()
                .map_err(|_| "topic retention lock is poisoned")?;
            retained.push_back(event.clone());
            while retained.len() > capacity {
                retained.pop_front();
            }
        }
        if self.inner.options.stored {
            if let Some(storage) = &self.inner.context.storage {
                let payload = serde_json::to_vec(&event.payload)?;
                storage.store_topic_event(
                    &self.inner.context.scope,
                    &self.inner.name,
                    event.sequence,
                    event.published_at_ms,
                    &payload,
                    capacity,
                )?;
            }
        }
        let _ = self.inner.sender.send(event.clone());
        Ok(Some(event))
    }

    /// Latest retained event.
    pub fn latest(&self) -> Result<Option<TopicEvent<T>>> {
        Ok(self
            .inner
            .retained
            .lock()
            .map_err(|_| "topic retention lock is poisoned")?
            .back()
            .cloned())
    }

    /// Current retained history after an optional sequence cursor.
    pub fn replay(&self, after_sequence: Option<u64>) -> Result<Vec<TopicEvent<T>>> {
        let after_sequence = after_sequence.unwrap_or_default();
        Ok(self
            .inner
            .retained
            .lock()
            .map_err(|_| "topic retention lock is poisoned")?
            .iter()
            .filter(|event| event.sequence > after_sequence)
            .cloned()
            .collect())
    }

    /// Replay retained events, then continue with live events.
    pub fn subscribe(
        &self,
        after_sequence: Option<u64>,
    ) -> Pin<Box<dyn Stream<Item = TopicEvent<T>> + Send>> {
        let inner = Arc::clone(&self.inner);
        let mut receiver = inner.sender.subscribe();
        let replay = self.replay(after_sequence).unwrap_or_default();
        Box::pin(async_stream::stream! {
            let mut last_sequence = after_sequence.unwrap_or_default();
            for event in replay {
                last_sequence = last_sequence.max(event.sequence);
                yield event;
            }
            loop {
                match receiver.recv().await {
                    Ok(event) if event.sequence > last_sequence => {
                        last_sequence = event.sequence;
                        yield event;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let recovered = inner
                            .retained
                            .lock()
                            .map(|retained| {
                                retained
                                    .iter()
                                    .filter(|event| event.sequence > last_sequence)
                                    .cloned()
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        for event in recovered {
                            last_sequence = event.sequence;
                            yield event;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }
}

fn validate_topic_key(value: &str, description: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("{description} must be a non-empty identifier").into());
    }
    Ok(())
}

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;

    use super::*;

    fn context() -> TopicContext {
        TopicContext::new(None, "fixture").unwrap()
    }

    #[test]
    fn live_topic_skips_publication_without_consumers() {
        let topic = context()
            .topic::<String>("requests", TopicOptions::live())
            .unwrap();

        assert!(!topic.is_active());
        assert_eq!(topic.publish("ignored".into()).unwrap(), None);
        assert_eq!(topic.replay(None).unwrap(), []);
    }

    #[tokio::test]
    async fn live_topic_publishes_only_while_subscribed() {
        let topic = context()
            .topic::<String>("requests", TopicOptions::live())
            .unwrap();
        let mut subscription = topic.subscribe(None);

        assert!(topic.is_active());
        topic.publish("request".into()).unwrap();
        assert_eq!(
            subscription.next().await.unwrap().payload,
            "request".to_owned()
        );
        drop(subscription);
        assert_eq!(topic.publish("ignored".into()).unwrap(), None);
    }

    #[test]
    fn latest_and_replay_topics_retain_state_without_subscribers() {
        let latest = context()
            .topic::<u64>("latest", TopicOptions::latest(false))
            .unwrap();
        latest.publish(1).unwrap();
        latest.publish(2).unwrap();
        assert_eq!(latest.latest().unwrap().unwrap().payload, 2);
        assert_eq!(
            latest
                .replay(None)
                .unwrap()
                .into_iter()
                .map(|event| event.payload)
                .collect::<Vec<_>>(),
            [2]
        );

        let replay = context()
            .topic::<u64>(
                "replay",
                TopicOptions::replay(NonZeroUsize::new(2).unwrap(), false),
            )
            .unwrap();
        for value in 1..=3 {
            replay.publish(value).unwrap();
        }
        assert_eq!(
            replay
                .replay(Some(1))
                .unwrap()
                .into_iter()
                .map(|event| event.payload)
                .collect::<Vec<_>>(),
            [2, 3]
        );
    }

    #[tokio::test]
    async fn lagged_subscription_recovers_from_retained_history() {
        let topic = context()
            .topic::<u64>(
                "replay",
                TopicOptions {
                    retention: TopicRetention::Replay(NonZeroUsize::new(4).unwrap()),
                    stored: false,
                    channel_capacity: NonZeroUsize::new(1).unwrap(),
                },
            )
            .unwrap();
        let mut subscription = topic.subscribe(None);
        for value in 1..=3 {
            topic.publish(value).unwrap();
        }

        let mut received = Vec::new();
        for _ in 0..3 {
            received.push(subscription.next().await.unwrap().payload);
        }
        assert_eq!(received, [1, 2, 3]);
    }

    #[test]
    fn sqlite_replay_restores_sequence_and_prunes_history() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ServiceStorage::open(directory.path()).unwrap();
        let context = TopicContext::new(Some(storage), "runtime").unwrap();
        let options = TopicOptions::replay(NonZeroUsize::new(2).unwrap(), true);
        let topic = context.topic::<String>("changes", options).unwrap();
        for value in ["one", "two", "three"] {
            topic.publish(value.to_owned()).unwrap();
        }
        drop(topic);

        let restored = context.topic::<String>("changes", options).unwrap();
        assert_eq!(
            restored
                .replay(None)
                .unwrap()
                .into_iter()
                .map(|event| (event.sequence, event.payload))
                .collect::<Vec<_>>(),
            [(2, "two".to_owned()), (3, "three".to_owned())]
        );
        assert_eq!(
            restored.publish("four".into()).unwrap().unwrap().sequence,
            4
        );
    }
}
