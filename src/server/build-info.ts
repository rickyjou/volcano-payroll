// `git archive` replaces these placeholders with the archived commit (export-subst in
// .gitattributes). The cloud frontend deploys from such an archive; a plain checkout keeps
// the placeholders.
export const BUILD_COMMIT = '$Format:%H$';
export const BUILD_COMMIT_DATE = '$Format:%cI$';
