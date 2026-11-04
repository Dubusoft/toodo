//! Schema migrations to versions 25 onward, in order. Released entries never change;
//! append new migrations here.

pub(super) const VERSIONS_25_ON: &[&str] = &[
    // Version 25: a task can ship through another task that has no recorded pull request,
    // e.g. one completed without one, so a task ID without a pull request URL is allowed
    // for tasks done as merged or completed. Rebuilt as version 24 was.
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
            CHECK (merged_with_task_id IS NULL OR resolution IN ('merged', 'completed')),
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
    // Version 26: project memory is gone. Its entries, shared and of each workspace, are
    // dropped with their indexes; nothing else references them.
    r"
    DROP INDEX IF EXISTS memory_entries_workspace_id;
    DROP INDEX IF EXISTS memory_entries_superseded_by;
    DROP TABLE IF EXISTS memory_entries;
    ",
    // Version 27: a workspace has a source, a completion mode, and a runner. Existing
    // workspaces get them from their tasks: a merged-locally criterion means a local git
    // repository merged locally, a pull request criterion or URL a GitHub repository
    // merged through pull requests. Workspaces without either keep the GitHub default
    // with `axes_detected` 0, so the server detects them from the repository's remotes.
    r"
    ALTER TABLE workspaces ADD COLUMN source TEXT NOT NULL DEFAULT 'github'
        CHECK (source IN ('none', 'local_git', 'github'));
    ALTER TABLE workspaces ADD COLUMN completion TEXT NOT NULL DEFAULT 'pr_merge'
        CHECK (completion IN ('manual', 'local_merge', 'pr_merge'));
    ALTER TABLE workspaces ADD COLUMN runner TEXT NOT NULL DEFAULT 'herdr'
        CHECK (runner IN ('none', 'herdr'));
    ALTER TABLE workspaces ADD COLUMN axes_detected INTEGER NOT NULL DEFAULT 1
        CHECK (axes_detected IN (0, 1));
    UPDATE workspaces SET source = 'local_git', completion = 'local_merge'
        WHERE EXISTS (SELECT 1 FROM task_criteria c JOIN tasks t ON t.id = c.task_id
                      WHERE t.workspace_id = workspaces.id
                        AND c.kind = 'branch_merged_locally');
    UPDATE workspaces SET axes_detected = 0
        WHERE source = 'github'
          AND NOT EXISTS (SELECT 1 FROM task_criteria c JOIN tasks t ON t.id = c.task_id
                          WHERE t.workspace_id = workspaces.id
                            AND c.kind IN ('pr_merged', 'pr_open_ci_green'))
          AND NOT EXISTS (SELECT 1 FROM tasks t
                          WHERE t.workspace_id = workspaces.id
                            AND t.pull_request_url IS NOT NULL);
    ",
    // Version 28: the git activity of each task (commits, pull request, CI results,
    // merge), one row per event and task however often it is reported.
    r"
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
    ",
    // Version 29: runtime records. Runtime workspaces are the runner workspaces (herdr
    // workspaces) tasks are open in, one open generation per task; task runs are the
    // agent launches made for a task, with their events and runner operations. Owner keys
    // are a placeholder for a later tenant context. The herdr handles on `tasks` stay the
    // source of truth: triggers shadow-write them into `runtime_workspaces`, and every
    // task with a herdr workspace gets an open generation-1 row. No runs are created.
    r"
    CREATE TABLE runtime_workspaces (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        host_ref TEXT NOT NULL,
        runner_kind TEXT NOT NULL CHECK (runner_kind IN ('herdr')),
        -- NULL until the provider instance (herdr server) is verified; unverified handles
        -- are not controlled through the runtime service.
        provider_instance TEXT,
        provider_workspace_ref TEXT NOT NULL,
        checkout_path TEXT,
        branch TEXT,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
    );
    CREATE UNIQUE INDEX runtime_workspaces_open_per_task
        ON runtime_workspaces (task_id) WHERE state = 'open';
    CREATE UNIQUE INDEX runtime_workspaces_generation
        ON runtime_workspaces (task_id, generation);

    CREATE TABLE agent_conversations (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        agent_kind TEXT NOT NULL,
        agent_version TEXT,
        host_ref TEXT NOT NULL,
        cwd TEXT,
        resume_kind TEXT NOT NULL CHECK (resume_kind IN
            ('none', 'exact_id', 'exact_path', 'named_session', 'transcript')),
        resume_ref TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        -- NULL for a run with no runtime workspace, e.g. a task of a workspace with source
        -- none and runner none: no checkout, no branch.
        runtime_workspace_id INTEGER REFERENCES runtime_workspaces (id) ON DELETE SET NULL,
        conversation_id INTEGER REFERENCES agent_conversations (id) ON DELETE SET NULL,
        request_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        runner_kind TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('writer', 'observer')),
        host_ref TEXT NOT NULL,
        checkout_path TEXT,
        adapter_profile TEXT,
        state TEXT NOT NULL CHECK (state IN
            ('reserved', 'running', 'settled', 'exited', 'failed', 'cancelled', 'unknown')),
        provider_run_ref TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        UNIQUE (owner_key, request_key),
        UNIQUE (task_id, generation)
    );
    -- One active writer per checkout. `unknown` counts as active: a run whose fate is not
    -- confirmed may still be writing.
    CREATE UNIQUE INDEX task_runs_one_active_writer
        ON task_runs (owner_key, host_ref, checkout_path)
        WHERE role = 'writer' AND checkout_path IS NOT NULL
          AND state IN ('reserved', 'running', 'unknown');

    CREATE TABLE run_events (
        run_id INTEGER NOT NULL REFERENCES task_runs (id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, sequence)
    );

    CREATE TABLE run_operations (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        run_id INTEGER NOT NULL REFERENCES task_runs (id) ON DELETE CASCADE,
        request_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('launch', 'input', 'stop')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'failed')),
        receipt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner_key, request_key, kind)
    );

    INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind, provider_workspace_ref,
        checkout_path, branch, generation, state, opened_at)
    SELECT t.id,
        CASE w.kind WHEN 'ssh' THEN 'ssh:' || w.herdr_machine ELSE 'local' END,
        'herdr', t.herdr_workspace_id, t.worktree_path, t.branch, 1, 'open',
        CAST(strftime('%s', 'now') AS INTEGER)
    FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.herdr_workspace_id IS NOT NULL;

    CREATE TRIGGER runtime_workspaces_task_inserted AFTER INSERT ON tasks
        WHEN NEW.herdr_workspace_id IS NOT NULL
    BEGIN
        INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind,
            provider_workspace_ref, checkout_path, branch, generation, state, opened_at)
        SELECT NEW.id,
            CASE w.kind WHEN 'ssh' THEN 'ssh:' || w.herdr_machine ELSE 'local' END,
            'herdr', NEW.herdr_workspace_id, NEW.worktree_path, NEW.branch,
            (SELECT coalesce(max(r.generation), 0) + 1
             FROM runtime_workspaces r WHERE r.task_id = NEW.id),
            'open', CAST(strftime('%s', 'now') AS INTEGER)
        FROM workspaces w WHERE w.id = NEW.workspace_id;
    END;
    CREATE TRIGGER runtime_workspaces_task_updated
        AFTER UPDATE OF herdr_workspace_id, worktree_path, branch ON tasks
        WHEN OLD.herdr_workspace_id IS NOT NEW.herdr_workspace_id
          OR OLD.worktree_path IS NOT NEW.worktree_path
          OR OLD.branch IS NOT NEW.branch
    BEGIN
        UPDATE runtime_workspaces
        SET state = 'closed', closed_at = CAST(strftime('%s', 'now') AS INTEGER)
        WHERE task_id = NEW.id AND state = 'open' AND runner_kind = 'herdr'
          AND (NEW.herdr_workspace_id IS NULL
               OR provider_workspace_ref IS NOT NEW.herdr_workspace_id);
        UPDATE runtime_workspaces
        SET checkout_path = NEW.worktree_path, branch = NEW.branch
        WHERE task_id = NEW.id AND state = 'open'
          AND provider_workspace_ref = NEW.herdr_workspace_id;
        INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind,
            provider_workspace_ref, checkout_path, branch, generation, state, opened_at)
        SELECT NEW.id,
            CASE w.kind WHEN 'ssh' THEN 'ssh:' || w.herdr_machine ELSE 'local' END,
            'herdr', NEW.herdr_workspace_id, NEW.worktree_path, NEW.branch,
            (SELECT coalesce(max(r.generation), 0) + 1
             FROM runtime_workspaces r WHERE r.task_id = NEW.id),
            'open', CAST(strftime('%s', 'now') AS INTEGER)
        FROM workspaces w
        WHERE w.id = NEW.workspace_id AND NEW.herdr_workspace_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM runtime_workspaces r
                          WHERE r.task_id = NEW.id AND r.state = 'open'
                            AND r.provider_workspace_ref = NEW.herdr_workspace_id);
    END;
    ",
    // Version 30: OAuth clients, owner grants, and hashed rotating credentials.
    r"
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
    ",
    // Version 31: runtime workspaces are the source of truth for the herdr workspace of a
    // task. The open rows are brought in line with the herdr handles on `tasks` once more
    // (the shadow triggers kept them so), then the triggers and the handle column go. The
    // checkout path and branch stay on `tasks`: they outlive the herdr workspace.
    r"
    UPDATE runtime_workspaces
    SET state = 'closed', closed_at = CAST(strftime('%s', 'now') AS INTEGER)
    WHERE state = 'open' AND runner_kind = 'herdr'
      AND NOT EXISTS (SELECT 1 FROM tasks t
                      WHERE t.id = runtime_workspaces.task_id
                        AND t.herdr_workspace_id = runtime_workspaces.provider_workspace_ref);
    UPDATE runtime_workspaces
    SET checkout_path = (SELECT t.worktree_path FROM tasks t
                         WHERE t.id = runtime_workspaces.task_id),
        branch = (SELECT t.branch FROM tasks t WHERE t.id = runtime_workspaces.task_id)
    WHERE state = 'open';
    INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind, provider_workspace_ref,
        checkout_path, branch, generation, state, opened_at)
    SELECT t.id,
        CASE w.kind WHEN 'ssh' THEN 'ssh:' || w.herdr_machine ELSE 'local' END,
        'herdr', t.herdr_workspace_id, t.worktree_path, t.branch,
        (SELECT coalesce(max(r.generation), 0) + 1
         FROM runtime_workspaces r WHERE r.task_id = t.id),
        'open', CAST(strftime('%s', 'now') AS INTEGER)
    FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.herdr_workspace_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM runtime_workspaces r
                      WHERE r.task_id = t.id AND r.state = 'open');

    DROP TRIGGER runtime_workspaces_task_inserted;
    DROP TRIGGER runtime_workspaces_task_updated;
    ALTER TABLE tasks DROP COLUMN herdr_workspace_id;
    ",
    // Version 32: append-only host observations and their per-host cursors.
    r"
    CREATE TABLE runtime_host_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        host_ref TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
            'workspace_opened', 'workspace_closed', 'online', 'offline', 'unknown',
            'snapshot_reconciled')),
        provider_workspace_ref TEXT,
        checkout_path TEXT,
        recorded_at TEXT NOT NULL,
        UNIQUE (owner_key, host_ref, sequence)
    );
    CREATE TABLE runtime_hosts (
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        host_ref TEXT NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        reconciled_sequence INTEGER,
        state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('online', 'offline', 'unknown')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, host_ref)
    );
    ",
    // Version 33: the `plain` runner, which runs agent CLIs on the server itself. SQLite
    // cannot change a CHECK constraint in place, so the workspaces table is rebuilt as
    // the tasks table was in version 2, keeping every column and its AUTOINCREMENT
    // counter so deleted workspace IDs are still never reused.
    r"
    CREATE TABLE workspaces_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        path TEXT NOT NULL,
        herdr_machine TEXT,
        default_base_branch TEXT NOT NULL,
        agent_merge TEXT NOT NULL DEFAULT 'never'
            CHECK (agent_merge IN ('never', 'after_checks')),
        source TEXT NOT NULL DEFAULT 'github'
            CHECK (source IN ('none', 'local_git', 'github')),
        completion TEXT NOT NULL DEFAULT 'pr_merge'
            CHECK (completion IN ('manual', 'local_merge', 'pr_merge')),
        runner TEXT NOT NULL DEFAULT 'herdr'
            CHECK (runner IN ('none', 'herdr', 'plain')),
        axes_detected INTEGER NOT NULL DEFAULT 1
            CHECK (axes_detected IN (0, 1)),
        CHECK ((kind = 'local') = (herdr_machine IS NULL))
    );
    INSERT INTO workspaces_new (id, name, kind, path, herdr_machine, default_base_branch,
        agent_merge, source, completion, runner, axes_detected)
    SELECT id, name, kind, path, herdr_machine, default_base_branch, agent_merge, source,
        completion, runner, axes_detected
    FROM workspaces;
    DELETE FROM sqlite_sequence WHERE name = 'workspaces_new';
    INSERT INTO sqlite_sequence (name, seq)
        SELECT 'workspaces_new', seq FROM sqlite_sequence WHERE name = 'workspaces';
    DROP TABLE workspaces;
    ALTER TABLE workspaces_new RENAME TO workspaces;
    ",
    // Version 34: tmux workspaces and runs. Keep the workspace ID counter, all runtime
    // references, and the unique indexes while widening the runner constraints.
    r"
    CREATE TABLE workspaces_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        path TEXT NOT NULL,
        herdr_machine TEXT,
        default_base_branch TEXT NOT NULL,
        agent_merge TEXT NOT NULL DEFAULT 'never'
            CHECK (agent_merge IN ('never', 'after_checks')),
        source TEXT NOT NULL DEFAULT 'github'
            CHECK (source IN ('none', 'local_git', 'github')),
        completion TEXT NOT NULL DEFAULT 'pr_merge'
            CHECK (completion IN ('manual', 'local_merge', 'pr_merge')),
        runner TEXT NOT NULL DEFAULT 'herdr'
            CHECK (runner IN ('none', 'herdr', 'plain', 'tmux')),
        axes_detected INTEGER NOT NULL DEFAULT 1 CHECK (axes_detected IN (0, 1)),
        CHECK ((kind = 'local') = (herdr_machine IS NULL))
    );
    INSERT INTO workspaces_new SELECT * FROM workspaces;
    DELETE FROM sqlite_sequence WHERE name = 'workspaces_new';
    INSERT INTO sqlite_sequence (name, seq)
        SELECT 'workspaces_new', seq FROM sqlite_sequence WHERE name = 'workspaces';
    DROP TABLE workspaces;
    ALTER TABLE workspaces_new RENAME TO workspaces;

    CREATE TABLE runtime_workspaces_new (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        host_ref TEXT NOT NULL,
        runner_kind TEXT NOT NULL CHECK (runner_kind IN ('herdr', 'plain', 'tmux', 'none')),
        provider_instance TEXT,
        provider_workspace_ref TEXT NOT NULL,
        checkout_path TEXT,
        branch TEXT,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
    );
    INSERT INTO runtime_workspaces_new SELECT * FROM runtime_workspaces;
    DROP TABLE runtime_workspaces;
    ALTER TABLE runtime_workspaces_new RENAME TO runtime_workspaces;
    CREATE UNIQUE INDEX runtime_workspaces_open_per_task
        ON runtime_workspaces (task_id) WHERE state = 'open';
    CREATE UNIQUE INDEX runtime_workspaces_generation
        ON runtime_workspaces (task_id, generation);

    CREATE TABLE task_runs_new (
        id INTEGER PRIMARY KEY,
        owner_key TEXT NOT NULL DEFAULT 'implicit',
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        runtime_workspace_id INTEGER REFERENCES runtime_workspaces (id) ON DELETE SET NULL,
        conversation_id INTEGER REFERENCES agent_conversations (id) ON DELETE SET NULL,
        request_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        runner_kind TEXT NOT NULL CHECK (runner_kind IN ('herdr', 'plain', 'tmux', 'none')),
        role TEXT NOT NULL CHECK (role IN ('writer', 'observer')),
        host_ref TEXT NOT NULL,
        checkout_path TEXT,
        adapter_profile TEXT,
        state TEXT NOT NULL CHECK (state IN
            ('reserved', 'running', 'settled', 'exited', 'failed', 'cancelled', 'unknown')),
        provider_run_ref TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        UNIQUE (owner_key, request_key),
        UNIQUE (task_id, generation)
    );
    INSERT INTO task_runs_new SELECT * FROM task_runs;
    DROP TABLE task_runs;
    ALTER TABLE task_runs_new RENAME TO task_runs;
    CREATE UNIQUE INDEX task_runs_one_active_writer
        ON task_runs (owner_key, host_ref, checkout_path)
        WHERE role = 'writer' AND checkout_path IS NOT NULL
          AND state IN ('reserved', 'running', 'unknown');
    ",
    // Version 35: task labels, such as a project or goal, that reviews filter by.
    r"
    CREATE TABLE task_labels (
        task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (length(trim(label)) > 0),
        PRIMARY KEY (task_id, label)
    ) WITHOUT ROWID;
    ",
];
