export const DIFF_EXPAND_BATCH_SIZE = 20;
export const MAX_RENDERED_DIFF_BYTES = 512 * 1024;

export const shouldBuildInlineDiff = ({
  expanded,
  isImage,
  isContentEqual,
  isOmitted,
  oldContent,
  newContent,
}: {
  expanded: boolean;
  isImage: boolean;
  isContentEqual: boolean;
  isOmitted: boolean;
  oldContent: string;
  newContent: string;
}): boolean =>
  expanded &&
  !isImage &&
  !isContentEqual &&
  !isOmitted &&
  oldContent.length + newContent.length <= MAX_RENDERED_DIFF_BYTES &&
  Boolean(oldContent || newContent);

export const bulkExpandedDiffIds = (ids: string[]): Set<string> =>
  new Set(ids.slice(0, DIFF_EXPAND_BATCH_SIZE));
