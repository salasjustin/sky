/** The lock file, inside the shared repo's `.git`, that serializes run setup and teardown writing to it on one sprite. */
export const REPO_LOCK_FILE = "sky-repo.lock";

/** `flock -E` status for a lock that stayed held for the whole wait. */
export const REPO_LOCK_TIMED_OUT = 75;

/**
 * How long, in seconds, a caller of the repo lock waits when it is given no bound of its own. Run setup
 * is given what is left of its launch deadline; worktree removal in the API waits less, because its
 * exec has a shorter bound.
 */
export const REPO_LOCK_WAIT_S = 120;
