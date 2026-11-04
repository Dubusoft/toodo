//! Schema migrations to versions 1 through 24, in order. Released entries never change.

pub(super) const VERSIONS_1_TO_24: &[&str] = &[
    // Version 1: initial schema. AUTOINCREMENT keeps workspace and task IDs from being
    // reused after a delete, because task IDs are part of branch and worktree names.
    r"
    CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        path TEXT NOT NULL,
        herdr_machine TEXT,
        default_base_branch TEXT NOT NULL,
        CHECK ((kind = 'local') = (herdr_machine IS NULL))
    );

    CREATE TABLE machine_settings (
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        label TEXT NOT NULL DEFAULT '',
        worktree_root TEXT,
        PRIMARY KEY (kind, label),
        CHECK ((kind = 'local') = (label = ''))
    );

    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        type TEXT NOT NULL
            CHECK (type IN ('feat', 'fix', 'modify', 'refactor', 'docs', 'test', 'chore')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL
            CHECK (status IN ('planned', 'ready', 'in_progress', 'done', 'cancelled')),
        branch TEXT,
        worktree_path TEXT,
        herdr_workspace_id TEXT,
        pull_request_url TEXT
    );
    CREATE INDEX tasks_workspace_id ON tasks (workspace_id);

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
    ",
    // Version 2: adds the `in_review` task status. SQLite cannot change a CHECK
    // constraint in place, so the tasks table is rebuilt, keeping its AUTOINCREMENT
    // counter so deleted task IDs are still never reused.
    r"
    CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        type TEXT NOT NULL
            CHECK (type IN ('feat', 'fix', 'modify', 'refactor', 'docs', 'test', 'chore')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL
            CHECK (status IN
                ('planned', 'ready', 'in_progress', 'in_review', 'done', 'cancelled')),
        branch TEXT,
        worktree_path TEXT,
        herdr_workspace_id TEXT,
        pull_request_url TEXT
    );
    INSERT INTO tasks_new (id, workspace_id, type, title, description, status, branch,
        worktree_path, herdr_workspace_id, pull_request_url)
    SELECT id, workspace_id, type, title, description, status, branch, worktree_path,
        herdr_workspace_id, pull_request_url
    FROM tasks;
    DELETE FROM sqlite_sequence WHERE name = 'tasks_new';
    INSERT INTO sqlite_sequence (name, seq)
        SELECT 'tasks_new', seq FROM sqlite_sequence WHERE name = 'tasks';
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX tasks_workspace_id ON tasks (workspace_id);
    ",
    // Version 3: task status history for the timeline, and the merge time of a task's
    // pull request. Tasks created before this version have no history.
    r"
    CREATE TABLE task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        status TEXT NOT NULL
            CHECK (status IN
                ('planned', 'ready', 'in_progress', 'in_review', 'done', 'cancelled')),
        at INTEGER NOT NULL
    );
    CREATE INDEX task_events_task_id ON task_events (task_id);
    ALTER TABLE tasks ADD COLUMN pull_request_merged_at INTEGER;
    ",
    // Version 4: four task statuses. Whether a task can start follows from its
    // dependencies instead of a `ready` status, and a cancelled task becomes a paused,
    // `planned` one. The first event of a task records its creation, so a leading `ready`
    // event becomes `planned`; the other `ready` events are dropped, and so is every
    // `planned` event that follows another one, which no longer marks a change. The
    // CHECK constraints still allow the old values, which Toodo no longer writes.
    r"
    UPDATE tasks SET status = 'planned' WHERE status IN ('ready', 'cancelled');
    UPDATE task_events SET status = 'planned' WHERE status = 'cancelled';
    UPDATE task_events SET status = 'planned'
        WHERE status = 'ready'
          AND id IN (SELECT min(id) FROM task_events GROUP BY task_id);
    DELETE FROM task_events WHERE status = 'ready';
    DELETE FROM task_events WHERE id IN (
        SELECT id FROM (
            SELECT id, status,
                   lag(status) OVER (PARTITION BY task_id ORDER BY id) AS previous
            FROM task_events
        )
        WHERE status = 'planned' AND previous = 'planned'
    );
    ",
    // Version 5: what reviews need about a completed task beyond its history: the note
    // the user writes about its outcome, and a snapshot of its merged pull request.
    r"
    ALTER TABLE tasks ADD COLUMN completion_note TEXT;
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
    ",
    // Version 6: the `rnd` task type, and how a `done` task ended: `merged`, or
    // `not_adopted` for work concluded without merging. Every task done before this
    // version was completed by its merge. The tasks table is rebuilt as in version 2 to
    // change its CHECK constraints; statuses that version 4 retired are no longer allowed.
    r"
    CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        type TEXT NOT NULL
            CHECK (type IN
                ('feat', 'fix', 'modify', 'refactor', 'docs', 'test', 'chore', 'rnd')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL
            CHECK (status IN ('planned', 'in_progress', 'in_review', 'done')),
        resolution TEXT CHECK (resolution IN ('merged', 'not_adopted')),
        branch TEXT,
        worktree_path TEXT,
        herdr_workspace_id TEXT,
        pull_request_url TEXT,
        pull_request_merged_at INTEGER,
        completion_note TEXT,
        CHECK ((status = 'done') = (resolution IS NOT NULL))
    );
    INSERT INTO tasks_new (id, workspace_id, type, title, description, status, resolution,
        branch, worktree_path, herdr_workspace_id, pull_request_url, pull_request_merged_at,
        completion_note)
    SELECT id, workspace_id, type, title, description, status,
        CASE WHEN status = 'done' THEN 'merged' END, branch, worktree_path,
        herdr_workspace_id, pull_request_url, pull_request_merged_at, completion_note
    FROM tasks;
    DELETE FROM sqlite_sequence WHERE name = 'tasks_new';
    INSERT INTO sqlite_sequence (name, seq)
        SELECT 'tasks_new', seq FROM sqlite_sequence WHERE name = 'tasks';
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX tasks_workspace_id ON tasks (workspace_id);
    ",
    // Version 7: the GitHub issue a task works on, whose closing reference Toodo keeps in
    // the task's pull request. Existing tasks have none.
    r"
    ALTER TABLE tasks ADD COLUMN issue_number INTEGER CHECK (issue_number > 0);
    ALTER TABLE tasks ADD COLUMN issue_url TEXT
        CHECK ((issue_url IS NULL) = (issue_number IS NULL));
    ",
    // Version 8: notes that agents leave on a task while working on it, through the MCP
    // server: progress and decisions, or what blocks them. Existing tasks have none.
    r"
    CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('progress', 'blocker')),
        body TEXT NOT NULL CHECK (body <> ''),
        at INTEGER NOT NULL
    );
    CREATE INDEX task_notes_task_id ON task_notes (task_id);
    ",
    // Version 9: what a task was planned to take, to compare with what it took: an
    // estimate in hours or points and a due day (`YYYY-MM-DD`; `date()` normalizes days a
    // month does not have and returns NULL for other text, so both fail the `IS` check).
    // Existing tasks have neither.
    r"
    ALTER TABLE tasks ADD COLUMN estimate_unit TEXT CHECK (estimate_unit IN ('hours', 'points'));
    ALTER TABLE tasks ADD COLUMN estimate_amount REAL
        CHECK ((estimate_amount IS NULL) = (estimate_unit IS NULL))
        CHECK (estimate_amount > 0);
    ALTER TABLE tasks ADD COLUMN due_date TEXT CHECK (date(due_date) IS due_date);
    ",
    // Version 10: estimates count time only, in hours, days, weeks, or months; points are
    // gone. Estimates in points have no time to compare with, so they are cleared. The
    // estimate columns are recreated to change their CHECK constraints: SQLite drops a
    // column whose own constraints reference another column, but not one referenced by
    // the constraints of another, so the amount goes before the unit.
    r"
    ALTER TABLE tasks RENAME COLUMN estimate_unit TO old_estimate_unit;
    ALTER TABLE tasks RENAME COLUMN estimate_amount TO old_estimate_amount;
    ALTER TABLE tasks ADD COLUMN estimate_unit TEXT
        CHECK (estimate_unit IN ('hours', 'days', 'weeks', 'months'));
    ALTER TABLE tasks ADD COLUMN estimate_amount REAL
        CHECK ((estimate_amount IS NULL) = (estimate_unit IS NULL))
        CHECK (estimate_amount > 0);
    UPDATE tasks SET estimate_unit = old_estimate_unit, estimate_amount = old_estimate_amount
        WHERE old_estimate_unit = 'hours';
    ALTER TABLE tasks DROP COLUMN old_estimate_amount;
    ALTER TABLE tasks DROP COLUMN old_estimate_unit;
    ",
    // Version 11: finding earlier tasks. `task_relations` links tasks that are related
    // without one waiting on the other, in any workspace; a link is stored once, from the
    // lower task ID to the higher one. `task_search` is a full-text index (FTS5 with the
    // trigram tokenizer, so any substring of three or more characters matches, in any
    // language) of what `task_search_source` says about each task: title, description,
    // completion note and agent notes, branch, and pull request title and URL. Its rowid
    // is the task ID, and the triggers below keep it in sync with every write. A later
    // migration that rebuilds one of these tables has to recreate the view and triggers.
    r"
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
    CREATE VIEW task_search_source (id, title, description, notes, branch, pull_request) AS
    SELECT t.id, t.title, t.description,
        trim(coalesce(t.completion_note, '') || char(10) || coalesce(
            (SELECT group_concat(n.body, char(10)) FROM task_notes n WHERE n.task_id = t.id),
            ''), char(10)),
        coalesce(t.branch, ''),
        trim(coalesce((SELECT s.title FROM pull_request_snapshots s WHERE s.task_id = t.id), '')
            || ' ' || coalesce(t.pull_request_url, ''))
    FROM tasks t;
    INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
        SELECT * FROM task_search_source;

    CREATE TRIGGER task_search_task_inserted AFTER INSERT ON tasks BEGIN
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = NEW.id;
    END;
    CREATE TRIGGER task_search_task_updated
        AFTER UPDATE OF title, description, completion_note, branch, pull_request_url ON tasks
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
    ",
    // Version 12: whether agents may merge their own pull request into the base branch.
    // Existing workspaces keep today's behavior: agents never merge.
    "
    ALTER TABLE workspaces ADD COLUMN agent_merge TEXT NOT NULL DEFAULT 'never'
        CHECK (agent_merge IN ('never', 'after_checks'));
    ",
    // Version 13: a task done as merged through the pull request of another task, e.g.
    // one pull request that fixed several tasks, records that pull request and its task.
    "
    ALTER TABLE tasks ADD COLUMN merged_with_pull_request_url TEXT
        CHECK (merged_with_pull_request_url IS NULL OR resolution = 'merged');
    ALTER TABLE tasks ADD COLUMN merged_with_task_id INTEGER
        REFERENCES tasks (id) ON DELETE SET NULL
        CHECK (merged_with_task_id IS NULL OR merged_with_pull_request_url IS NOT NULL);
    ",
    // Version 14: project memory. Entries belong to one workspace, or to none, which
    // makes them shared by every workspace. Replacing an entry keeps it, pointing at its
    // replacement through `superseded_by`; current entries have none.
    "
    CREATE TABLE memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER REFERENCES workspaces (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('decision', 'rule', 'note', 'summary')),
        title TEXT NOT NULL CHECK (trim(title) <> ''),
        body TEXT NOT NULL DEFAULT '',
        task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        superseded_by INTEGER REFERENCES memory_entries (id) ON DELETE SET NULL,
        CHECK (superseded_by IS NULL OR superseded_by <> id)
    );
    CREATE INDEX memory_entries_workspace_id ON memory_entries (workspace_id);
    CREATE INDEX memory_entries_superseded_by ON memory_entries (superseded_by);
    ",
    // Version 15: devices that use toodo-server, each with its own access token, stored
    // only as a SHA-256 hash. Revoked devices are kept, so their id stays unique.
    "
    CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL CHECK (trim(label) <> ''),
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
    );
    ",
    // Version 16: completion criteria. A task is done once every criterion is met; Toodo
    // checks every kind but `manual` on its own. `target` holds the URL or command to
    // check, or the commit a `branch_merged_locally` branch started from. Existing tasks
    // get theirs from the data step [`import_criteria`].
    "
    CREATE TABLE task_criteria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL CHECK (trim(text) <> ''),
        kind TEXT NOT NULL CHECK (kind IN ('manual', 'pr_merged', 'pr_open_ci_green',
            'branch_merged_locally', 'url', 'command')),
        target TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'met', 'failed')),
        evidence TEXT,
        checked_by TEXT CHECK (checked_by IN ('user', 'agent', 'toodo')),
        checked_at INTEGER,
        CHECK (CASE kind
            WHEN 'url' THEN target IS NOT NULL
            WHEN 'command' THEN target IS NOT NULL
            WHEN 'branch_merged_locally' THEN 1
            ELSE target IS NULL END)
    );
    CREATE INDEX task_criteria_task_id ON task_criteria (task_id, position);
    ",
    // Version 17: the Web Push subscription of each device, with the kinds of
    // notification it wants. A device has at most one (its browser's), and an endpoint
    // belongs to one device.
    "
    CREATE TABLE push_subscriptions (
        device_id INTEGER PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
        p256dh BLOB NOT NULL CHECK (length(p256dh) = 65),
        auth BLOB NOT NULL CHECK (length(auth) = 16),
        agent INTEGER NOT NULL DEFAULT 1 CHECK (agent IN (0, 1)),
        pull_requests INTEGER NOT NULL DEFAULT 1 CHECK (pull_requests IN (0, 1)),
        completion INTEGER NOT NULL DEFAULT 1 CHECK (completion IN (0, 1)),
        created_at INTEGER NOT NULL
    );
    ",
    // Version 18: the conversation with the lead in the chat panel. A client names each
    // message it sends, so sending it again does not repeat it.
    "
    CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL CHECK (author IN ('user', 'lead')),
        body TEXT NOT NULL CHECK (trim(body) <> ''),
        client_id TEXT UNIQUE CHECK (client_id IS NULL OR author = 'user'),
        at INTEGER NOT NULL
    );
    ",
    // Version 19: when a person's message reached the lead's pane, and when the lead
    // picked it up. Earlier messages were all typed into the pane before they were
    // stored; those the lead answered afterwards count as picked up.
    "
    ALTER TABLE chat_messages ADD COLUMN delivered_at INTEGER
        CHECK (delivered_at IS NULL OR author = 'user');
    ALTER TABLE chat_messages ADD COLUMN seen_at INTEGER
        CHECK (seen_at IS NULL OR delivered_at IS NOT NULL);
    UPDATE chat_messages SET delivered_at = at WHERE author = 'user';
    UPDATE chat_messages SET seen_at = delivered_at
        WHERE author = 'user'
          AND EXISTS (SELECT 1 FROM chat_messages AS later
                      WHERE later.author = 'lead' AND later.id > chat_messages.id);
    ",
    // Version 20: the lead's inbox. A person's message is stored before it reaches the
    // lead's pane, and status changes the lead acts on are kept for it, until the lead
    // takes them; earlier messages were typed into the pane in full, so they count as
    // taken. The lead names each task it creates or starts with a request ID, so a request
    // it handles again does not create or start a task twice.
    "
    ALTER TABLE chat_messages ADD COLUMN taken_at INTEGER
        CHECK (taken_at IS NULL OR author = 'user');
    UPDATE chat_messages SET taken_at = delivered_at WHERE author = 'user';
    ALTER TABLE task_events ADD COLUMN for_lead INTEGER NOT NULL DEFAULT 0
        CHECK (for_lead IN (0, 1));
    ALTER TABLE task_events ADD COLUMN taken_at INTEGER
        CHECK (taken_at IS NULL OR for_lead = 1);
    ALTER TABLE task_events ADD COLUMN request_id TEXT;
    CREATE UNIQUE INDEX task_events_request_id ON task_events (request_id)
        WHERE request_id IS NOT NULL;
    CREATE INDEX task_events_for_lead ON task_events (id)
        WHERE for_lead = 1 AND taken_at IS NULL;
    ",
    // Version 21: how each task finished, with what showed it, and the system's report of
    // it in the chat. A finish is stored with the change that made it, so each one has one
    // report; the chat keeps the report when the task is deleted.
    "
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
    CREATE TABLE chat_messages_v21 (
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
    );
    INSERT INTO chat_messages_v21
        (id, author, body, client_id, at, delivered_at, seen_at, taken_at)
        SELECT id, author, body, client_id, at, delivered_at, seen_at, taken_at
        FROM chat_messages;
    DROP TABLE chat_messages;
    ALTER TABLE chat_messages_v21 RENAME TO chat_messages;
    ",
    // Version 22: receipts of the lead's work. A person's message gets the time it becomes
    // overdue when it is stored, the lead's acknowledgement, and when and with what (its
    // reply or a task made for it) the lead handled it; earlier messages have none, so
    // they are never overdue, and their estimated `seen_at` never counts as handled. Each
    // done event links the system's report of the finish, found for earlier events by the
    // result stored with them.
    "
    ALTER TABLE chat_messages ADD COLUMN due_at INTEGER
        CHECK (due_at IS NULL OR author = 'user');
    ALTER TABLE chat_messages ADD COLUMN acked_at INTEGER
        CHECK (acked_at IS NULL OR author = 'user');
    ALTER TABLE chat_messages ADD COLUMN handled_at INTEGER
        CHECK (handled_at IS NULL OR acked_at IS NOT NULL);
    ALTER TABLE chat_messages ADD COLUMN handled_reply_id INTEGER
        REFERENCES chat_messages (id)
        CHECK (handled_reply_id IS NULL OR handled_at IS NOT NULL);
    ALTER TABLE chat_messages ADD COLUMN handled_task_id INTEGER
        REFERENCES tasks (id) ON DELETE SET NULL
        CHECK (handled_task_id IS NULL OR handled_at IS NOT NULL);
    CREATE INDEX chat_messages_open ON chat_messages (id)
        WHERE handled_at IS NULL AND due_at IS NOT NULL;
    ALTER TABLE task_events ADD COLUMN report_id INTEGER
        REFERENCES chat_messages (id)
        CHECK (report_id IS NULL OR status = 'done');
    UPDATE task_events SET report_id =
        (SELECT min(c.id) FROM chat_messages c JOIN task_results r ON r.id = c.result_id
         WHERE r.task_id = task_events.task_id AND r.at = task_events.at)
        WHERE status = 'done';
    ",
    // Version 23: messages imported from another chat (see `Storage::import_chat_message`)
    // keep where they came from: the origin's label and the message's ID there, unique per
    // origin so importing one again stores nothing.
    "
    ALTER TABLE chat_messages ADD COLUMN origin TEXT
        CHECK (origin IS NULL OR author IN ('user', 'lead'));
    ALTER TABLE chat_messages ADD COLUMN origin_id TEXT
        CHECK ((origin IS NULL) = (origin_id IS NULL));
    CREATE UNIQUE INDEX chat_messages_origin ON chat_messages (origin, origin_id)
        WHERE origin IS NOT NULL;
    ",
    // Version 24: completed work with no pull request is distinct from merged work.
    // Rebuild the CHECK constraint, retaining references, the ID counter and search.
    r"
    DROP TRIGGER task_search_task_inserted;
    DROP TRIGGER task_search_task_updated;
    DROP TRIGGER task_search_task_deleted;
    DROP TRIGGER task_search_note_inserted;
    DROP TRIGGER task_search_note_deleted;
    DROP TRIGGER task_search_pull_request_inserted;
    DROP TRIGGER task_search_pull_request_updated;
    DROP TRIGGER task_search_pull_request_deleted;
    DROP VIEW task_search_source;
    CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        type TEXT NOT NULL
            CHECK (type IN ('feat', 'fix', 'modify', 'refactor', 'docs', 'test', 'chore', 'rnd')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'in_review', 'done')),
        resolution TEXT CHECK (resolution IN ('merged', 'completed', 'not_adopted')),
        branch TEXT,
        worktree_path TEXT,
        herdr_workspace_id TEXT,
        pull_request_url TEXT,
        pull_request_merged_at INTEGER,
        completion_note TEXT,
        issue_number INTEGER CHECK (issue_number > 0),
        issue_url TEXT CHECK ((issue_url IS NULL) = (issue_number IS NULL)),
        due_date TEXT CHECK (date(due_date) IS due_date),
        estimate_unit TEXT CHECK (estimate_unit IN ('hours', 'days', 'weeks', 'months')),
        estimate_amount REAL
            CHECK ((estimate_amount IS NULL) = (estimate_unit IS NULL))
            CHECK (estimate_amount > 0),
        merged_with_pull_request_url TEXT
            CHECK (merged_with_pull_request_url IS NULL OR resolution = 'merged'),
        merged_with_task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL
            CHECK (merged_with_task_id IS NULL OR merged_with_pull_request_url IS NOT NULL),
        CHECK ((status = 'done') = (resolution IS NOT NULL))
    );
    INSERT INTO tasks_new (id, workspace_id, type, title, description, status, resolution,
        branch, worktree_path, herdr_workspace_id, pull_request_url, pull_request_merged_at,
        completion_note, issue_number, issue_url, due_date, estimate_unit, estimate_amount,
        merged_with_pull_request_url, merged_with_task_id)
    SELECT id, workspace_id, type, title, description, status, resolution,
        branch, worktree_path, herdr_workspace_id, pull_request_url, pull_request_merged_at,
        completion_note, issue_number, issue_url, due_date, estimate_unit, estimate_amount,
        merged_with_pull_request_url, merged_with_task_id
    FROM tasks;
    DELETE FROM sqlite_sequence WHERE name = 'tasks_new';
    INSERT INTO sqlite_sequence (name, seq)
        SELECT 'tasks_new', seq FROM sqlite_sequence WHERE name = 'tasks';
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX tasks_workspace_id ON tasks (workspace_id);
    CREATE VIEW task_search_source (id, title, description, notes, branch, pull_request) AS
    SELECT t.id, t.title, t.description,
        trim(coalesce(t.completion_note, '') || char(10) || coalesce(
            (SELECT group_concat(n.body, char(10)) FROM task_notes n WHERE n.task_id = t.id),
            ''), char(10)),
        coalesce(t.branch, ''),
        trim(coalesce((SELECT s.title FROM pull_request_snapshots s WHERE s.task_id = t.id), '')
            || ' ' || coalesce(t.pull_request_url, ''))
    FROM tasks t;
    CREATE TRIGGER task_search_task_inserted AFTER INSERT ON tasks BEGIN
        INSERT INTO task_search (rowid, title, description, notes, branch, pull_request)
            SELECT * FROM task_search_source WHERE id = NEW.id;
    END;
    CREATE TRIGGER task_search_task_updated
        AFTER UPDATE OF title, description, completion_note, branch, pull_request_url ON tasks
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
    ",
];
