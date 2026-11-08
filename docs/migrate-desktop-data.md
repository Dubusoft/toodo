# Move Desktop App Data to a Server

Earlier releases of Toodo shipped a Windows desktop app with its own database. Toodo is
now `toodo-server` with its web app (see [server.md](server.md)), and
`toodo-server import` adds the desktop app's data to a server. The import never changes
the file it reads, and the server's existing data stays.

## Steps

1. **Finish or pause running work.** In the desktop app, finish or pause the tasks that are
   in progress, so their status history is complete before the copy.
2. **Make a copy of the database.** The desktop app keeps it in
   `%APPDATA%\dev.toodo.app\toodo.sqlite3`, with its automatic backups in
   `%APPDATA%\dev.toodo.app\backups\`. Either quit the app and copy the file, or use
   *Settings > Backups > Export* in the last desktop release, which writes a consistent
   snapshot while the app runs.
3. **Copy it to the server**, for example:

   ```sh
   scp toodo.sqlite3 me@server:toodo-desktop.sqlite3
   ```

4. **Stop the service** on the server:

   ```sh
   systemctl --user stop toodo-server
   ```

5. **Import the copy** with the same `TOODO_DATA_DIR` as the service (the default is
   `~/.local/share/toodo-server`; the unit sets it in `toodo-server.service`):

   ```sh
   TOODO_DATA_DIR=~/.local/share/toodo-server toodo-server import ~/toodo-desktop.sqlite3
   ```

   It writes a pre-restore backup into `<data>/backups/` first and prints its name. It
   also prints the task ID offset: task #N of the desktop app becomes #(N + offset). Into
   an empty server, tasks keep their numbers.
6. **Start the service** again:

   ```sh
   systemctl --user start toodo-server
   ```

7. **Check the web app.** The imported workspaces show in the sidebar, and their tasks
   keep their status history, commits, notes, and criteria.

## What Changes for Imported Data

- **Workspace paths, runners, and worktree settings are dropped.** A workspace is now a
  group of tasks with a name, an optional description, and an optional repository name;
  the server keeps no paths or machines.
- **Execution records aren't imported**: herdr workspace links, runs, and machine
  settings belonged to the PC.
- **Devices, push subscriptions, connected OAuth apps, settings, saved reviews, and chat
  messages aren't imported.** Browsers sign in to
  the server on their own.

## Undo

Restore the pre-restore backup the command printed: in the web app under *Settings >
Backups*, or with `POST /api/backups/restore` (see [server.md](server.md#api)). That
brings back the server's data from just before the import.

## Tests

The import is covered by tests in `src-tauri/src/storage/import.rs`.
