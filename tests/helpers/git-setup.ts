import { afterAll } from 'vitest'
import { installIsolatedGitEnvironment, restoreGitEnvironment } from './git-env'

// Runs before the test file is imported, so fixtures see the controlled
// environment from their first `git` invocation, including when a single test
// is selected with `-t`.
installIsolatedGitEnvironment()

afterAll(() => {
  restoreGitEnvironment()
})
