-- The baseline schema (version 56), the last one the Rust server migrated to. New databases
-- start from it; change the schema with a migration in `database.ts`, never here.
PRAGMA user_version = 56;

CREATE TABLE task_dependencies (
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        depends_on_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_id),
        CHECK (task_id <> depends_on_id)
    ) WITHOUT ROWID;

CREATE INDEX task_dependencies_depends_on_id ON task_dependencies (depends_on_id);

CREATE TABLE commit_records (
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        sha TEXT NOT NULL,
        message TEXT NOT NULL,
        author TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, sha)
    );

CREATE TABLE pull_request_snapshots (
        task_id INTEGER PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        changed_files INTEGER NOT NULL,
        merge_commit_sha TEXT,
        review_count INTEGER NOT NULL,
        reviewer_count INTEGER NOT NULL,
        first_reviewed_at INTEGER
    );

CREATE TABLE task_relations (
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        related_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, related_id),
        CHECK (task_id < related_id)
    ) WITHOUT ROWID;

CREATE INDEX task_relations_related_id ON task_relations (related_id);

CREATE VIRTUAL TABLE task_search USING fts5 (
        title, description, notes, branch, pull_request, tokenize = 'trigram'
    );

CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL CHECK (trim(label) <> ''),
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
    , expires_at INTEGER, scope TEXT NOT NULL DEFAULT 'full'
        CHECK (scope IN ('full', 'read')));

CREATE TABLE push_subscriptions (
        device_id INTEGER PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
        p256dh BLOB NOT NULL CHECK (length(p256dh) = 65),
        auth BLOB NOT NULL CHECK (length(auth) = 16),
        completion INTEGER NOT NULL DEFAULT 1 CHECK (completion IN (0, 1)),
        created_at INTEGER NOT NULL
    , last_failure TEXT, last_failure_at INTEGER, messages INTEGER NOT NULL DEFAULT 1
        CHECK (messages IN (0, 1)));

CREATE TABLE task_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL
            CHECK (kind IN ('pr_ready', 'merged', 'not_adopted', 'completed')),
        pull_request_number INTEGER,
        pull_request_url TEXT,
        commit_sha TEXT,
        at INTEGER NOT NULL
    );

CREATE INDEX task_results_task ON task_results (task_id);

CREATE TABLE "chat_messages" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL CHECK (author IN ('user', 'lead', 'system')),
        body TEXT NOT NULL CHECK (trim(body) <> ''),
        client_id TEXT UNIQUE CHECK (client_id IS NULL OR author = 'user'),
        at INTEGER NOT NULL,
        delivered_at INTEGER CHECK (delivered_at IS NULL OR author = 'user'),
        seen_at INTEGER CHECK (seen_at IS NULL OR delivered_at IS NOT NULL),
        taken_at INTEGER CHECK (taken_at IS NULL OR author = 'user'),
        result_id INTEGER UNIQUE REFERENCES task_results (id) ON DELETE SET NULL
            CHECK (result_id IS NULL OR author = 'system')
    , due_at INTEGER
        CHECK (due_at IS NULL OR author = 'user'), acked_at INTEGER
        CHECK (acked_at IS NULL OR author = 'user'), handled_at INTEGER
        CHECK (handled_at IS NULL OR acked_at IS NOT NULL), handled_reply_id INTEGER
        REFERENCES chat_messages (id)
        CHECK (handled_reply_id IS NULL OR handled_at IS NOT NULL), handled_task_id INTEGER
        REFERENCES tasks (id) ON DELETE SET NULL
        CHECK (handled_task_id IS NULL OR handled_at IS NOT NULL), origin TEXT
        CHECK (origin IS NULL OR author IN ('user', 'lead')), origin_id TEXT
        CHECK ((origin IS NULL) = (origin_id IS NULL)), channel_id INTEGER NOT NULL DEFAULT 1
        REFERENCES chat_channels (id), thread_id INTEGER REFERENCES chat_threads (id));

CREATE INDEX chat_messages_open ON chat_messages (id)
        WHERE handled_at IS NULL AND due_at IS NOT NULL;

CREATE UNIQUE INDEX chat_messages_origin ON chat_messages (origin, origin_id)
        WHERE origin IS NOT NULL;

CREATE TABLE task_activity (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        dedup_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        external_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL,
        UNIQUE (task_id, dedup_key)
    );

CREATE INDEX task_activity_by_task ON task_activity (task_id, occurred_at);

CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        secret_hash TEXT,
        client_name TEXT,
        redirect_uris TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

CREATE TABLE oauth_grants (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_name TEXT,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
    );

CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        expires_at INTEGER NOT NULL,
        used_at INTEGER
    );

CREATE INDEX oauth_tokens_by_grant ON oauth_tokens(grant_id);

CREATE TABLE task_labels (
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (length(trim(label)) > 0),
        PRIMARY KEY (task_id, label)
    ) WITHOUT ROWID;

CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

CREATE TABLE review_snapshots (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        period TEXT NOT NULL,
        from_day TEXT NOT NULL,
        to_day TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        workspace_id INTEGER,
        label TEXT,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        entries TEXT NOT NULL,
        workspaces TEXT NOT NULL,
        markdown TEXT NOT NULL,
        csv TEXT NOT NULL
    );

CREATE TABLE "task_notes" (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('progress', 'blocker', 'decision')),
        body TEXT NOT NULL CHECK (body <> ''),
        at INTEGER NOT NULL
    );

CREATE INDEX task_notes_task_id ON task_notes (task_id);

CREATE TABLE "workspaces" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, repository TEXT, archived_at INTEGER);

CREATE TABLE "tasks" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        type TEXT NOT NULL
            CHECK (type IN ('feat', 'fix', 'modify', 'refactor', 'docs', 'test', 'chore', 'rnd')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'in_review', 'done')),
        resolution TEXT CHECK (resolution IN ('merged', 'completed', 'not_adopted')),
        completion_note TEXT,
        issue_number INTEGER CHECK (issue_number > 0),
        issue_url TEXT CHECK ((issue_url IS NULL) = (issue_number IS NULL)),
        due_date TEXT CHECK (date(due_date) IS due_date),
        estimate_unit TEXT CHECK (estimate_unit IN ('hours', 'days', 'weeks', 'months')),
        estimate_amount REAL
            CHECK ((estimate_amount IS NULL) = (estimate_unit IS NULL))
            CHECK (estimate_amount > 0),
        archived_at INTEGER,
        refs TEXT NOT NULL DEFAULT '[]', wait_until INTEGER, wait_status TEXT
        CHECK (wait_status IN ('planned', 'in_progress', 'in_review')), autopilot INTEGER NOT NULL DEFAULT 0
        CHECK (autopilot IN (0, 1)), autopilot_at INTEGER
        CHECK ((autopilot = 1) = (autopilot_at IS NOT NULL)),
        CHECK ((status = 'done') = (resolution IS NOT NULL))
    );

CREATE INDEX tasks_workspace_id ON tasks (workspace_id);

CREATE TABLE "task_criteria" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL CHECK (trim(text) <> ''),
        kind TEXT NOT NULL CHECK (kind IN ('manual', 'url')),
        target TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'met', 'failed')),
        evidence TEXT,
        checked_by TEXT CHECK (checked_by IN ('user', 'agent', 'toodo')),
        checked_at INTEGER,
        CHECK ((kind = 'url') = (target IS NOT NULL))
    );

CREATE INDEX task_criteria_task_id ON task_criteria (task_id, position);

CREATE VIEW task_search_source (id, title, description, notes, branch, pull_request) AS
    SELECT t.id, t.title, t.description,
        trim(coalesce(t.completion_note, '') || char(10) || coalesce(
            (SELECT group_concat(n.body, char(10)) FROM task_notes n WHERE n.task_id = t.id),
            ''), char(10)),
        trim(coalesce(
            (SELECT group_concat(r.value, ' ') FROM json_each(t.refs) r), '')),
        trim(coalesce((SELECT s.title FROM pull_request_snapshots s WHERE s.task_id = t.id), '')
            || '')
    FROM tasks t;

CREATE TRIGGER task_search_task_inserted AFTER INSERT ON tasks BEGIN
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = NEW.id;
    END;

CREATE TRIGGER task_search_task_updated
        AFTER UPDATE OF title, description, completion_note, refs
        ON tasks
    BEGIN
        DELETE FROM task_search WHERE rowid = OLD.id;
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = NEW.id;
    END;

CREATE TRIGGER task_search_task_deleted AFTER DELETE ON tasks BEGIN
        DELETE FROM task_search WHERE rowid = OLD.id;
    END;

CREATE TRIGGER task_search_note_inserted AFTER INSERT ON task_notes BEGIN
        DELETE FROM task_search WHERE rowid = NEW.task_id;
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = NEW.task_id;
    END;

CREATE TRIGGER task_search_note_deleted AFTER DELETE ON task_notes BEGIN
        DELETE FROM task_search WHERE rowid = OLD.task_id;
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = OLD.task_id;
    END;

CREATE TRIGGER task_search_pull_request_inserted AFTER INSERT ON pull_request_snapshots
    BEGIN
        DELETE FROM task_search WHERE rowid = NEW.task_id;
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = NEW.task_id;
    END;

CREATE TRIGGER task_search_pull_request_updated AFTER UPDATE ON pull_request_snapshots
    BEGIN
        DELETE FROM task_search WHERE rowid = OLD.task_id;
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = OLD.task_id;
    END;

CREATE TRIGGER task_search_pull_request_deleted AFTER DELETE ON pull_request_snapshots
    BEGIN
        DELETE FROM task_search WHERE rowid = OLD.task_id;
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = OLD.task_id;
    END;

CREATE TABLE workspace_guidelines (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('rule', 'memory')),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

CREATE INDEX workspace_guidelines_workspace_id ON workspace_guidelines (workspace_id);

CREATE INDEX tasks_wait_until ON tasks (wait_until) WHERE wait_until IS NOT NULL;

CREATE INDEX tasks_autopilot ON tasks (id) WHERE autopilot = 1;

CREATE TRIGGER tasks_wait_pair_inserted BEFORE INSERT ON tasks
        WHEN (NEW.wait_until IS NULL) <> (NEW.wait_status IS NULL)
    BEGIN
        SELECT RAISE(ABORT, 'a task waits with both wait_until and wait_status or neither');
    END;

CREATE TRIGGER tasks_wait_pair_updated BEFORE UPDATE OF wait_until, wait_status ON tasks
        WHEN (NEW.wait_until IS NULL) <> (NEW.wait_status IS NULL)
    BEGIN
        SELECT RAISE(ABORT, 'a task waits with both wait_until and wait_status or neither');
    END;

CREATE TABLE "task_events" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        status TEXT NOT NULL
            CHECK (status IN
                ('planned', 'ready', 'in_progress', 'in_review', 'done', 'cancelled')),
        at INTEGER NOT NULL,
        for_lead INTEGER NOT NULL DEFAULT 0 CHECK (for_lead IN (0, 1)),
        taken_at INTEGER CHECK (taken_at IS NULL OR for_lead = 1),
        request_id TEXT,
        report_id INTEGER REFERENCES chat_messages (id)
            CHECK (report_id IS NULL OR status = 'done'),
        reason TEXT
    );

CREATE INDEX task_events_task_id ON task_events (task_id);

CREATE UNIQUE INDEX task_events_request_id ON task_events (request_id)
        WHERE request_id IS NOT NULL;

CREATE INDEX task_events_for_lead ON task_events (id)
        WHERE for_lead = 1 AND taken_at IS NULL;

CREATE TABLE "task_adoptions" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        at INTEGER NOT NULL
    );

CREATE INDEX task_adoptions_task_id ON task_adoptions (task_id);

CREATE TABLE chat_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (trim(name) <> ''),
        push INTEGER NOT NULL DEFAULT 1 CHECK (push IN (0, 1)),
        read_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );

CREATE TABLE chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES chat_channels (id),
        title TEXT NOT NULL CHECK (trim(title) <> ''),
        task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
        created_at INTEGER NOT NULL,
        closed_at INTEGER CHECK ((closed_at IS NULL) = (status = 'open')),
        archived_at INTEGER CHECK ((archived_at IS NULL) = (status <> 'archived')),
        read_id INTEGER NOT NULL DEFAULT 0
    );

CREATE INDEX chat_threads_channel ON chat_threads (channel_id);

CREATE INDEX chat_threads_task ON chat_threads (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX chat_messages_place ON chat_messages (channel_id, thread_id, id);

CREATE TABLE chat_actions (
        message_id INTEGER NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        key TEXT NOT NULL CHECK (trim(key) <> ''),
        label TEXT NOT NULL CHECK (trim(label) <> ''),
        style TEXT NOT NULL DEFAULT 'default' CHECK (style IN ('default', 'primary', 'danger')),
        PRIMARY KEY (message_id, key)
    ) WITHOUT ROWID;

CREATE TABLE chat_choices (
        message_id INTEGER PRIMARY KEY REFERENCES chat_messages (id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        choice_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages (id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        FOREIGN KEY (message_id, key) REFERENCES chat_actions (message_id, key)
    );

CREATE TABLE chat_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_key TEXT NOT NULL UNIQUE,
        message_id INTEGER REFERENCES chat_messages (id) ON DELETE CASCADE,
        uploader TEXT NOT NULL CHECK (uploader IN ('user', 'lead')),
        name TEXT NOT NULL CHECK (trim(name) <> ''),
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at INTEGER NOT NULL
    );

CREATE INDEX chat_attachments_message ON chat_attachments (message_id);

CREATE VIRTUAL TABLE chat_search USING fts5 (
        body, content = 'chat_messages', content_rowid = 'id', tokenize = 'trigram'
    );

CREATE TRIGGER chat_search_inserted AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_search (rowid, body) VALUES (NEW.id, NEW.body);
    END;

CREATE TRIGGER chat_search_updated AFTER UPDATE OF body ON chat_messages BEGIN
        INSERT INTO chat_search (chat_search, rowid, body) VALUES ('delete', OLD.id, OLD.body);
        INSERT INTO chat_search (rowid, body) VALUES (NEW.id, NEW.body);
    END;

CREATE TRIGGER chat_search_deleted AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_search (chat_search, rowid, body) VALUES ('delete', OLD.id, OLD.body);
    END;
