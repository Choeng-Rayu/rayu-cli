//! Integration tests for [`rayu_core::store`] against a real MySQL.
//!
//! These are skipped unless `RAYU_TEST_DATABASE_URL` is set, so `cargo test` on a
//! machine without a database still passes. CI and the local dev loop point it at
//! a throwaway container seeded from the Prisma schema -- never at a real
//! database, because these tests INSERT and UPDATE.
//!
//! Bring one up with:
//!
//! ```text
//! docker run -d --name rayu-rust-test-mysql \
//!   -e MYSQL_ROOT_PASSWORD=testroot -e MYSQL_DATABASE=rayu_test \
//!   -p 13306:3306 mysql:8.0
//! cd rayu-backend && node_modules/.bin/prisma migrate diff \
//!   --from-empty --to-schema-datamodel prisma/schema.prisma --script \
//!   | docker exec -i rayu-rust-test-mysql mysql -uroot -ptestroot rayu_test
//! export RAYU_TEST_DATABASE_URL='mysql://root:testroot@127.0.0.1:13306/rayu_test'
//! ```

use chrono::{Duration, Utc};
use rayu_core::store::Store;
use sqlx::Executor;

/// Opens a store, or returns `None` when no test database is configured.
async fn store() -> Option<Store> {
    let url = std::env::var("RAYU_TEST_DATABASE_URL").ok()?;
    Some(
        Store::open(&url)
            .await
            .expect("RAYU_TEST_DATABASE_URL is set but unreachable"),
    )
}

/// Empties every table these tests touch, so each test starts from a known state
/// and cannot be order-dependent.
async fn reset(st: &Store) {
    let pool = st.pool();
    // Children before parents; FK checks off keeps the order from mattering if the
    // schema gains a relation later.
    pool.execute("SET FOREIGN_KEY_CHECKS=0").await.unwrap();
    for table in [
        "credit_ledger",
        "credit_topups",
        "usage_events",
        "credit_pools",
        "organization_subscriptions",
        "organization_members",
        "organizations",
        "subscriptions",
        "provider_api_keys",
        "hosted_models",
        "media_models",
        "providers",
        "plans",
        "users",
        "app_settings",
    ] {
        pool.execute(format!("DELETE FROM {table}").as_str())
            .await
            .unwrap();
    }
    pool.execute("SET FOREIGN_KEY_CHECKS=1").await.unwrap();
}

/// These tests share ONE database and seed fixed primary keys, so they must not
/// interleave. cargo runs integration tests on a thread pool by default, which
/// produced duplicate-key failures; a process-wide lock serialises them without
/// forcing every caller to remember `--test-threads=1`.
static DB_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Acquires the shared-database lock and opens a store, or skips the test when no
/// test database is configured. The returned guard must stay alive for the whole
/// test body.
macro_rules! require_db {
    () => {{
        let guard = DB_LOCK.lock().await;
        match store().await {
            Some(s) => (s, guard),
            None => {
                eprintln!("skipping: RAYU_TEST_DATABASE_URL not set");
                return;
            }
        }
    }};
}

#[tokio::test]
async fn settings_fall_back_to_go_defaults_when_the_row_is_missing() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;

    let s = st.load_settings().await.unwrap();
    assert_eq!(s.baseline_credits_per_1m, 1000);
    assert_eq!(s.max_concurrent_streams, 3);
    assert_eq!(s.max_tokens_per_request, 0);
    assert_eq!(s.credits_per_dollar, 0);
    assert_eq!(s.min_topup_cents, 0);
}

#[tokio::test]
async fn settings_read_the_singleton_row() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    st.pool()
        .execute(
            "INSERT INTO app_settings \
             (id,baselineCreditsPer1M,creditsPerDollar,minTopupCents,maxConcurrentStreams,\
              maxTokensPerRequest,maxRequestsPer5h,assumedInputRatio,assumedUsagePercent,\
              infraCostCentsPerUser,updatedAt) \
             VALUES (1,2000,500,100,7,64000,900,0.67,25,0,NOW(3))",
        )
        .await
        .unwrap();

    let s = st.load_settings().await.unwrap();
    assert_eq!(s.baseline_credits_per_1m, 2000);
    assert_eq!(s.credits_per_dollar, 500);
    assert_eq!(s.min_topup_cents, 100);
    assert_eq!(s.max_concurrent_streams, 7);
    assert_eq!(s.max_tokens_per_request, 64000);
    assert_eq!(s.max_requests_per_5h, 900);
}

#[tokio::test]
async fn models_join_their_provider_and_tolerate_nulls() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();

    pool.execute(
        "INSERT INTO providers (id,name,label,format,baseUrl,endpointPath,authScheme,\
         supportsReasoning,supportsImage,enabled,createdAt,updatedAt) VALUES \
         (1,'deepseek','DeepSeek','anthropic_messages','https://api.deepseek.com',\
          '/anthropic/v1/messages','x_api_key',1,0,1,NOW(3),NOW(3)), \
         (2,'nullpath','NullPath','openai_chat','https://api.example.com',\
          NULL,'bearer',0,0,1,NOW(3),NOW(3))",
    )
    .await
    .unwrap();

    pool.execute(
        "INSERT INTO hosted_models (id,code,label,provider_id,upstreamModelId,\
         inputPricePer1MCents,outputPricePer1MCents,creditMultiplier,outputCreditMultiplier,\
         cacheReadCreditMultiplier,cacheWriteCreditMultiplier,allowedPlanCodes,contextWindow,\
         supportsReasoning,supportsImage,supportsTools,enabled,createdAt,updatedAt) VALUES \
         (1,'glm-5.2','GLM 5.2',1,'deepseek-chat',14,28,1.0,2.0,0.1,1.0,\
          '[\"pro\",\"max\"]',200000,1,1,1,1,NOW(3),NOW(3)), \
         (2,'no-window','No Window',2,'gpt-x',0,0,1.0,1.0,0.1,1.0,NULL,NULL,\
          0,0,1,0,NOW(3),NOW(3)), \
         (3,'zero-window','Zero Window',2,'gpt-y',0,0,1.0,1.0,0.1,1.0,'[]',0,\
          0,0,1,1,NOW(3),NOW(3))",
    )
    .await
    .unwrap();

    let models = st.load_models().await.unwrap();
    assert_eq!(models.len(), 3);

    let glm = models.iter().find(|m| m.code == "glm-5.2").unwrap();
    assert_eq!(glm.provider_name(), "deepseek");
    assert_eq!(glm.provider.format, "anthropic_messages");
    assert_eq!(glm.provider.base_url, "https://api.deepseek.com");
    assert_eq!(glm.provider.endpoint_path, "/anthropic/v1/messages");
    assert_eq!(glm.provider.auth_scheme, "x_api_key");
    assert!(glm.provider.enabled);
    assert_eq!(glm.upstream_model_id, "deepseek-chat");
    assert_eq!(glm.input_price_per_1m_cents, 14);
    assert_eq!(glm.output_price_per_1m_cents, 28);
    assert_eq!(glm.credit_multiplier, 1.0);
    assert_eq!(glm.output_credit_multiplier, 2.0);
    assert_eq!(glm.cache_read_credit_multiplier, 0.1);
    assert_eq!(glm.allowed_plan_codes, vec!["pro", "max"]);
    assert_eq!(glm.context_window, Some(200_000));
    assert!(glm.supports_reasoning && glm.supports_image && glm.supports_tools);
    assert!(glm.enabled);

    // A NULL endpointPath becomes "" so the format default applies later.
    let nw = models.iter().find(|m| m.code == "no-window").unwrap();
    assert_eq!(nw.provider.endpoint_path, "");
    assert_eq!(nw.context_window, None);
    assert!(nw.allowed_plan_codes.is_empty());
    assert!(!nw.enabled);

    // A stored 0 window reads as "unset", matching Go's `> 0` guard.
    let zw = models.iter().find(|m| m.code == "zero-window").unwrap();
    assert_eq!(zw.context_window, None);
}

#[tokio::test]
async fn media_models_keep_display_order_and_raw_default_params() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;

    st.pool()
        .execute(
            "INSERT INTO media_models (id,code,label,mediaType,capabilities,backend,family,\
             nvcfFunctionId,estimatedSeconds,defaultParams,allowedPlanCodes,isDefault,sortOrder,\
             enabled,createdAt,updatedAt) VALUES \
             (1,'flux.1-schnell','Flux Schnell','image','[\"generate\"]','nvidia','flux',\
              NULL,5,'{\"steps\":4,\"cfg_scale\":0}','[]',1,1,1,NOW(3),NOW(3)), \
             (2,'veo-3','Veo 3','video','[\"text2video\",\"image2video\"]','vertex','veo',\
              'abc-123',90,NULL,'[\"max\"]',0,2,1,NOW(3),NOW(3)), \
             (3,'aaa-first','Sorts First','image','[\"edit\"]','fal','flux',\
              NULL,NULL,NULL,NULL,0,0,0,NOW(3),NOW(3))",
        )
        .await
        .unwrap();

    let media = st.load_media_models().await.unwrap();
    assert_eq!(media.len(), 3);
    // ORDER BY mediaType, sortOrder, id -> image(0), image(1), video(2)
    assert_eq!(media[0].code, "aaa-first");
    assert_eq!(media[1].code, "flux.1-schnell");
    assert_eq!(media[2].code, "veo-3");

    let flux = &media[1];
    assert_eq!(flux.capabilities, vec!["generate"]);
    assert_eq!(flux.backend, "nvidia");
    assert_eq!(flux.family, "flux");
    assert_eq!(flux.nvcf_function_id, "");
    assert_eq!(flux.estimated_seconds, Some(5));
    assert!(flux.is_default);
    assert!(flux.has_capability("generate"));
    assert!(!flux.has_capability("edit"));
    // defaultParams is carried through verbatim, not reinterpreted.
    let params = flux.default_params.as_ref().unwrap();
    assert_eq!(params["steps"], 4);
    assert_eq!(params["cfg_scale"], 0);

    let veo = &media[2];
    assert_eq!(veo.nvcf_function_id, "abc-123");
    assert_eq!(veo.capabilities, vec!["text2video", "image2video"]);
    assert_eq!(veo.allowed_plan_codes, vec!["max"]);
    assert!(veo.default_params.is_none());

    let first = &media[0];
    assert_eq!(first.estimated_seconds, None);
    assert!(!first.enabled);
}

#[tokio::test]
async fn provider_keys_come_back_in_try_order() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();

    pool.execute(
        "INSERT INTO providers (id,name,label,format,baseUrl,authScheme,enabled,createdAt,updatedAt) \
         VALUES (1,'p1','P1','openai_chat','https://a.example','bearer',1,NOW(3),NOW(3)), \
                (2,'p2','P2','openai_chat','https://b.example','bearer',1,NOW(3),NOW(3))",
    )
    .await
    .unwrap();

    pool.execute(
        "INSERT INTO provider_api_keys (id,provider_id,label,encryptedKey,keyHash,maskedKey,\
         priority,enabled,status,cooldownUntil,createdAt,updatedAt) VALUES \
         (10,1,'third','v1:ccc','h3','***(3)',5,1,'active',NULL,NOW(3),NOW(3)), \
         (11,1,'first','v1:aaa','h1','***(1)',0,1,'active',NULL,NOW(3),NOW(3)), \
         (12,1,'second','v1:bbb','h2','***(2)',0,0,'rate_limited','2030-01-02 03:04:05',NOW(3),NOW(3)), \
         (13,2,'other','v1:ddd','h4','***(4)',0,1,'invalid',NULL,NOW(3),NOW(3))",
    )
    .await
    .unwrap();

    let keys = st.load_provider_keys().await.unwrap();
    // ORDER BY provider_id, priority, id
    let order: Vec<i64> = keys.iter().map(|k| k.id).collect();
    assert_eq!(order, vec![11, 12, 10, 13]);

    let cooling = keys.iter().find(|k| k.id == 12).unwrap();
    assert_eq!(cooling.status, "rate_limited");
    assert!(!cooling.enabled);
    assert_eq!(
        cooling.cooldown_until.unwrap().to_rfc3339(),
        "2030-01-02T03:04:05+00:00",
        "DATETIME must be read as UTC, not the server's local zone"
    );
    assert!(keys
        .iter()
        .find(|k| k.id == 11)
        .unwrap()
        .cooldown_until
        .is_none());
    assert_eq!(
        keys.iter().find(|k| k.id == 11).unwrap().encrypted_key,
        "v1:aaa"
    );
}

#[tokio::test]
async fn active_plan_falls_back_to_free_and_honours_expiry() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();
    let now = Utc::now();

    pool.execute(
        "INSERT INTO plans (id,code,name,priceCents,availability,limits,is_team_plan,seat_credits) VALUES \
         (1,'free','Free',0,'available','{\"creditsPerPeriod\":10,\"maxDailyTurns\":5}',0,0), \
         (2,'pro','Pro',1900,'available',\
          '{\"creditsPerPeriod\":500,\"maxDailyTurns\":40,\"topUpEnabled\":true}',0,0)",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO users (id,email,emailVerified,role,status,createdAt) VALUES \
         (1,'none@example.com',1,'user','active',NOW(3)), \
         (2,'pro@example.com',1,'user','active',NOW(3)), \
         (3,'lapsed@example.com',1,'user','suspended',NOW(3))",
    )
    .await
    .unwrap();

    // user 2: active pro, period in the future. user 3: active pro, lapsed.
    let future = (now + Duration::days(20)).naive_utc().to_string();
    let past = (now - Duration::days(1)).naive_utc().to_string();
    pool.execute(
        format!(
            "INSERT INTO subscriptions (id,user_id,plan_id,status,startedAt,currentPeriodEnd) VALUES \
             (1,2,2,'active','2026-01-01 00:00:00','{future}'), \
             (2,3,2,'active','2026-01-01 00:00:00','{past}')"
        )
        .as_str(),
    )
    .await
    .unwrap();

    // No subscription at all -> free, no period end.
    let (plan, pe) = st.active_plan(1, now).await.unwrap();
    let plan = plan.unwrap();
    assert_eq!(plan.code, "free");
    assert_eq!(plan.credits_per_period, Some(10));
    assert_eq!(plan.max_daily_turns, Some(5));
    assert!(!plan.top_up_enabled);
    assert!(pe.is_none());

    // Active, unexpired -> pro with its period end.
    let (plan, pe) = st.active_plan(2, now).await.unwrap();
    let plan = plan.unwrap();
    assert_eq!(plan.code, "pro");
    assert_eq!(plan.price_cents, 1900);
    assert_eq!(plan.credits_per_period, Some(500));
    assert!(plan.top_up_enabled);
    assert!(pe.is_some(), "an unexpired period must be reported");

    // Lapsed period -> reverts to free with NO period end.
    let (plan, pe) = st.active_plan(3, now).await.unwrap();
    assert_eq!(plan.unwrap().code, "free");
    assert!(pe.is_none(), "a lapsed period must not be reported");
}

#[tokio::test]
async fn active_plan_picks_the_most_recent_active_subscription() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();

    pool.execute(
        "INSERT INTO plans (id,code,name,priceCents,availability,limits,is_team_plan,seat_credits) VALUES \
         (1,'free','Free',0,'available','{}',0,0), \
         (2,'pro','Pro',1900,'available','{\"creditsPerPeriod\":500}',0,0), \
         (3,'max','Max',4900,'available','{\"creditsPerPeriod\":2000}',0,0)",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO users (id,email,emailVerified,role,status,createdAt) \
         VALUES (1,'u@example.com',1,'user','active',NOW(3))",
    )
    .await
    .unwrap();
    // An older pro plus a newer max, both active, and a cancelled newest.
    pool.execute(
        "INSERT INTO subscriptions (id,user_id,plan_id,status,startedAt,currentPeriodEnd) VALUES \
         (1,1,2,'active','2026-01-01 00:00:00',NULL), \
         (2,1,3,'active','2026-06-01 00:00:00',NULL), \
         (3,1,2,'canceled','2026-07-01 00:00:00',NULL)",
    )
    .await
    .unwrap();

    let (plan, _) = st.active_plan(1, Utc::now()).await.unwrap();
    assert_eq!(
        plan.unwrap().code,
        "max",
        "must pick the newest ACTIVE subscription by startedAt"
    );
}

#[tokio::test]
async fn user_status_and_missing_user() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    st.pool()
        .execute(
            "INSERT INTO users (id,email,emailVerified,role,status,createdAt) VALUES \
             (1,'a@example.com',1,'user','active',NOW(3)), \
             (2,'b@example.com',1,'user','suspended',NOW(3))",
        )
        .await
        .unwrap();

    assert_eq!(st.user_status(1).await.unwrap(), "active");
    assert_eq!(st.user_status(2).await.unwrap(), "suspended");
    // A missing user is an empty string, not an error -- the caller then reports
    // "account is unknown".
    assert_eq!(st.user_status(999).await.unwrap(), "");
}

#[tokio::test]
async fn topup_balance_subtracts_consumption_and_floors_at_zero() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();
    pool.execute(
        "INSERT INTO users (id,email,emailVerified,role,status,createdAt) VALUES \
         (1,'a@example.com',1,'user','active',NOW(3)), \
         (2,'b@example.com',1,'user','active',NOW(3)), \
         (3,'c@example.com',1,'user','active',NOW(3))",
    )
    .await
    .unwrap();

    pool.execute(
        "INSERT INTO credit_topups (user_id,credits,amountCents,status,createdAt) VALUES \
         (1,100,100,'paid',NOW(3)), \
         (1,50,50,'pending',NOW(3)), \
         (2,10,10,'paid',NOW(3))",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO credit_ledger (user_id,modelCode,inTokens,outTokens,credits,realCostCents,\
         source,createdAt) VALUES \
         (1,'m',0,0,30,0,'topup',NOW()), \
         (1,'m',0,0,900,0,'plan',NOW()), \
         (2,'m',0,0,999,0,'topup',NOW())",
    )
    .await
    .unwrap();

    // 100 paid (pending ignored) - 30 topup-sourced consumption = 70.
    // The 900 plan-sourced row must NOT count.
    assert_eq!(st.topup_balance(1).await.unwrap(), 70);
    // Over-consumed floors at 0 rather than going negative.
    assert_eq!(st.topup_balance(2).await.unwrap(), 0);
    // No rows at all is 0, not an error.
    assert_eq!(st.topup_balance(3).await.unwrap(), 0);
}

#[tokio::test]
async fn insert_usage_event_writes_null_model_and_bumps_last_active() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    st.pool()
        .execute(
            "INSERT INTO users (id,email,emailVerified,role,status,createdAt,lastActiveAt) \
             VALUES (1,'a@example.com',1,'user','active',NOW(3),NULL)",
        )
        .await
        .unwrap();

    st.insert_usage_event(1, "anthropic", "claude-sonnet-4-6", "gateway")
        .await
        .unwrap();
    // An empty model must land as NULL, not "".
    st.insert_usage_event(1, "bedrock", "", "studio")
        .await
        .unwrap();

    let rows: Vec<(String, Option<String>, String)> =
        sqlx::query_as("SELECT provider, model, source FROM usage_events ORDER BY id")
            .fetch_all(st.pool())
            .await
            .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "anthropic");
    assert_eq!(rows[0].1.as_deref(), Some("claude-sonnet-4-6"));
    assert_eq!(rows[0].2, "gateway");
    assert_eq!(rows[1].0, "bedrock");
    assert_eq!(rows[1].1, None, "empty model must be stored as NULL");
    assert_eq!(rows[1].2, "studio");

    let last_active: Option<chrono::NaiveDateTime> =
        sqlx::query_scalar("SELECT lastActiveAt FROM users WHERE id=1")
            .fetch_one(st.pool())
            .await
            .unwrap();
    assert!(
        last_active.is_some(),
        "insert_usage_event must bump users.lastActiveAt"
    );
}

#[tokio::test]
async fn insert_ledger_writes_the_individual_shape() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    st.pool()
        .execute(
            "INSERT INTO users (id,email,emailVerified,role,status,createdAt) \
             VALUES (1,'a@example.com',1,'user','active',NOW(3))",
        )
        .await
        .unwrap();

    st.insert_ledger(1, "glm-5.2", 1200, 340, 7, 42, "plan")
        .await
        .unwrap();

    let row: (
        i32,
        String,
        i32,
        i32,
        i32,
        i32,
        String,
        Option<i32>,
        Option<i32>,
    ) = sqlx::query_as(
        "SELECT user_id, modelCode, inTokens, outTokens, credits, realCostCents, source, \
             organization_id, member_user_id FROM credit_ledger",
    )
    .fetch_one(st.pool())
    .await
    .unwrap();
    assert_eq!(row.0, 1);
    assert_eq!(row.1, "glm-5.2");
    assert_eq!(row.2, 1200);
    assert_eq!(row.3, 340);
    assert_eq!(row.4, 7);
    assert_eq!(row.5, 42);
    assert_eq!(row.6, "plan");
    assert_eq!(
        row.7, None,
        "individual rows must leave organization_id NULL"
    );
    assert_eq!(row.8, None);
}

#[tokio::test]
async fn update_provider_key_state_stores_null_for_an_empty_error() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();
    pool.execute(
        "INSERT INTO providers (id,name,label,format,baseUrl,authScheme,enabled,createdAt,updatedAt) \
         VALUES (1,'p','P','openai_chat','https://a.example','bearer',1,NOW(3),NOW(3))",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO provider_api_keys (id,provider_id,label,encryptedKey,keyHash,maskedKey,\
         priority,enabled,status,createdAt,updatedAt) \
         VALUES (1,1,'k','v1:x','h','***(1)',0,1,'active',NOW(3),NOW(3))",
    )
    .await
    .unwrap();

    let cooldown = Utc::now() + Duration::seconds(60);
    st.update_provider_key_state(
        1,
        "rate_limited",
        Some(cooldown),
        "HTTP 429 rate limited",
        Utc::now(),
    )
    .await
    .unwrap();

    let (status, cool, err): (String, Option<chrono::NaiveDateTime>, Option<String>) =
        sqlx::query_as("SELECT status, cooldownUntil, lastError FROM provider_api_keys WHERE id=1")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(status, "rate_limited");
    assert!(cool.is_some());
    assert_eq!(err.as_deref(), Some("HTTP 429 rate limited"));

    // Clearing health: no cooldown, no error -> both NULL.
    st.update_provider_key_state(1, "active", None, "", Utc::now())
        .await
        .unwrap();
    let (status, cool, err): (String, Option<chrono::NaiveDateTime>, Option<String>) =
        sqlx::query_as("SELECT status, cooldownUntil, lastError FROM provider_api_keys WHERE id=1")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(status, "active");
    assert_eq!(cool, None);
    assert_eq!(err, None, "an empty lastError must be stored as NULL");
}

/// Seeds an org with one member, a subscription, and a pool.
async fn seed_team(st: &Store, sub_status: &str, period_end: Option<&str>) {
    let pool = st.pool();
    pool.execute(
        "INSERT INTO plans (id,code,name,priceCents,availability,limits,is_team_plan,seat_credits) \
         VALUES (1,'free','Free',0,'available','{}',0,0), \
                (5,'team','Team',9900,'available',\
                 '{\"creditsPerPeriod\":5000,\"maxDailyTurns\":100}',1,500)",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO users (id,email,emailVerified,role,status,createdAt) VALUES \
         (1,'admin@example.com',1,'user','active',NOW(3)), \
         (2,'member@example.com',1,'user','active',NOW(3))",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO organizations (id,name,slug,admin_id,status,createdAt,updatedAt) \
         VALUES (7,'Acme','acme',1,'active',NOW(3),NOW(3))",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO organization_members (id,organization_id,user_id,role,bucket_credits,\
         bucket_quota,status,joined_at,updatedAt) \
         VALUES (1,7,2,'member',300,500,'active',NOW(3),NOW(3))",
    )
    .await
    .unwrap();
    let pe = match period_end {
        Some(v) => format!("'{v}'"),
        None => "NULL".to_string(),
    };
    pool.execute(
        format!(
            "INSERT INTO organization_subscriptions (id,organization_id,plan_id,status,startedAt,\
             currentPeriodEnd,createdAt,updatedAt) \
             VALUES (1,7,5,'{sub_status}','2026-01-01 00:00:00',{pe},NOW(3),NOW(3))"
        )
        .as_str(),
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO credit_pools (id,organization_id,total_credits,used_credits,period_end,\
         createdAt,updatedAt) VALUES (1,7,5000,1200,NULL,NOW(3),NOW(3))",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn org_member_state_resolves_in_one_round_trip() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    seed_team(&st, "active", Some("2099-01-01 00:00:00")).await;

    let state = st.org_member_state(7, 2).await.unwrap().unwrap();
    assert_eq!(state.org_id, 7);
    assert_eq!(state.org_status, "active");
    assert_eq!(state.member_status, "active");
    assert_eq!(state.member_role, "member");
    assert_eq!(state.sub_status, "active");
    assert!(state.has_plan);
    assert_eq!(state.plan.code, "team");
    assert_eq!(state.plan.credits_per_period, Some(5000));
    assert_eq!(state.plan.max_daily_turns, Some(100));
    assert_eq!(state.bucket_quota, 500);
    assert_eq!(state.bucket_credits, 300);
    assert_eq!(state.pool_total, 5000);
    assert_eq!(state.pool_used, 1200);
    assert_eq!(state.pool_remaining(), 3800);
    assert_eq!(state.usable(Utc::now()), (true, String::new()));
}

#[tokio::test]
async fn org_member_state_is_none_for_a_stale_claim() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    seed_team(&st, "active", None).await;

    // User 1 is the admin but holds NO seat row; user 999 does not exist; org 99
    // does not exist. All three must be None so the caller bills individually.
    assert!(st.org_member_state(7, 1).await.unwrap().is_none());
    assert!(st.org_member_state(7, 999).await.unwrap().is_none());
    assert!(st.org_member_state(99, 2).await.unwrap().is_none());
}

#[tokio::test]
async fn org_member_state_resolves_a_team_with_no_plan() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    let pool = st.pool();
    pool.execute(
        "INSERT INTO users (id,email,emailVerified,role,status,createdAt) VALUES \
         (1,'a@example.com',1,'user','active',NOW(3)), (2,'b@example.com',1,'user','active',NOW(3))",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO organizations (id,name,slug,admin_id,status,createdAt,updatedAt) \
         VALUES (7,'Acme','acme',1,'active',NOW(3),NOW(3))",
    )
    .await
    .unwrap();
    pool.execute(
        "INSERT INTO organization_members (id,organization_id,user_id,role,bucket_credits,\
         bucket_quota,status,joined_at,updatedAt) \
         VALUES (1,7,2,'member',0,0,'active',NOW(3),NOW(3))",
    )
    .await
    .unwrap();

    // The LEFT JOINs must keep this resolvable rather than looking like a missing
    // membership.
    let state = st.org_member_state(7, 2).await.unwrap().unwrap();
    assert!(!state.has_plan);
    assert_eq!(state.sub_status, "");
    assert_eq!(state.pool_total, 0);
    assert_eq!(state.usable(Utc::now()).1, "team_no_plan");
}

#[tokio::test]
async fn debit_org_member_floors_the_bucket_and_moves_the_pool_atomically() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    seed_team(&st, "active", None).await;

    // 300 remaining in the bucket; charge 500 -> bucket floors at 0, pool += 500.
    st.debit_org_member(7, 2, 500).await.unwrap();

    let bucket: i32 =
        sqlx::query_scalar("SELECT bucket_credits FROM organization_members WHERE id=1")
            .fetch_one(st.pool())
            .await
            .unwrap();
    let used: i32 = sqlx::query_scalar("SELECT used_credits FROM credit_pools WHERE id=1")
        .fetch_one(st.pool())
        .await
        .unwrap();
    assert_eq!(bucket, 0, "bucket must floor at 0, never go negative");
    assert_eq!(used, 1700, "pool must absorb the full charge");

    // A non-positive charge is a no-op (Go returns early).
    st.debit_org_member(7, 2, 0).await.unwrap();
    st.debit_org_member(7, 2, -5).await.unwrap();
    let used_after: i32 = sqlx::query_scalar("SELECT used_credits FROM credit_pools WHERE id=1")
        .fetch_one(st.pool())
        .await
        .unwrap();
    assert_eq!(used_after, 1700);
}

#[tokio::test]
async fn insert_org_ledger_attributes_to_both_org_and_member() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    seed_team(&st, "active", None).await;

    st.insert_org_ledger(7, 2, "glm-5.2", 900, 120, 3, 11, "pool")
        .await
        .unwrap();

    let row: (i32, Option<i32>, Option<i32>, String, i32, String) = sqlx::query_as(
        "SELECT user_id, organization_id, member_user_id, modelCode, credits, source \
         FROM credit_ledger",
    )
    .fetch_one(st.pool())
    .await
    .unwrap();
    // user_id equals member_user_id so the member's personal history still works.
    assert_eq!(row.0, 2);
    assert_eq!(row.1, Some(7));
    assert_eq!(row.2, Some(2));
    assert_eq!(row.3, "glm-5.2");
    assert_eq!(row.4, 3);
    assert_eq!(row.5, "pool");
}

#[tokio::test]
async fn suspended_team_and_lapsed_period_are_not_usable() {
    let (st, _db_guard) = require_db!();
    reset(&st).await;
    seed_team(&st, "past_due", None).await;
    let state = st.org_member_state(7, 2).await.unwrap().unwrap();
    assert_eq!(state.usable(Utc::now()).1, "team_past_due");

    reset(&st).await;
    seed_team(&st, "active", Some("2020-01-01 00:00:00")).await;
    let state = st.org_member_state(7, 2).await.unwrap().unwrap();
    assert_eq!(state.usable(Utc::now()).1, "team_period_ended");

    st.pool()
        .execute("UPDATE organizations SET status='suspended' WHERE id=7")
        .await
        .unwrap();
    let state = st.org_member_state(7, 2).await.unwrap().unwrap();
    assert_eq!(state.usable(Utc::now()).1, "team_suspended");

    st.pool()
        .execute("UPDATE organizations SET status='active' WHERE id=7")
        .await
        .unwrap();
    st.pool()
        .execute("UPDATE organization_members SET status='removed' WHERE id=1")
        .await
        .unwrap();
    let state = st.org_member_state(7, 2).await.unwrap().unwrap();
    assert_eq!(state.usable(Utc::now()).1, "membership_removed");
}
