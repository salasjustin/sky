/** The lock file, inside the shared repo's `.git`, that serializes run setup and teardown writing to it on one sprite. */
export const REPO_LOCK_FILE = "sky-repo.lock";

/** `flock -E` status for a lock that stayed held for the whole wait. */
export const REPO_LOCK_TIMED_OUT = 75;

/** How long, in seconds, a step waits for the repo lock before it fails naming the lock. */
export const REPO_LOCK_WAIT_S = 120;
