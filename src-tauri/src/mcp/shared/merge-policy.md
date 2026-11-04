Whether you merge your pull request yourself is set per workspace by `agentMerge`, which `current_task` returns:

- `never` (the default): stop once the pull request is open and never merge it; the user merges it, and the merge completes the task.
- `afterChecks`: wait until every check on the pull request has finished and passed (`gh pr checks <number> --watch`); when one fails, fix it, push, and wait again. Then merge the pull request into `baseBranch` (`gh pr merge <number> --merge`, or the merge method the repository allows); the merge completes the task.

Even with `afterChecks`, never merge while a check is failing or pending or when the pull request has no checks, never bypass branch protection (no `--admin`), never merge a pull request into any branch other than `baseBranch`, and never release, tag, or merge `baseBranch` onward (e.g. into `main`).
