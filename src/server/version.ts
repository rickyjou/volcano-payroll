import { BUILD_COMMIT, BUILD_COMMIT_DATE } from './build-info';

export interface VersionInfo {
  commit: string | null;
  committedAt: string | null;
}

// A value still shaped like `$Format:...$` was never substituted (not built from `git archive`).
function substituted(value: string): string | null {
  return value.startsWith('$Format:') ? null : value;
}

export function versionInfo(commit = BUILD_COMMIT, committedAt = BUILD_COMMIT_DATE): VersionInfo {
  return { commit: substituted(commit), committedAt: substituted(committedAt) };
}
