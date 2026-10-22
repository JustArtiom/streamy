// The library's public face: the rest of the engine imports from here only.
// See ./types.ts for the LibraryStore interface and ./sqlite-library.ts for
// how library.db is opened.

export { connectLibrary, type LibrarySources } from "./hooks";
export { LIBRARY_FILE, openEngineLibrary, THUMBNAILS_DIR } from "./open";
export {
  type InMemoryLibraryOptions,
  type OpenLibraryOptions,
  openInMemoryLibrary,
  openLibrary,
} from "./sqlite-library";
export {
  type RuntimeState,
  thumbnailUrl,
  toContinueWatchingItem,
  toFileProgress,
  toLibrary,
  toLibraryTorrent,
  toLibraryTorrentDetail,
} from "./mappers";
export {
  CONTINUE_WATCHING_LIMIT,
  CONTINUE_WATCHING_MIN_POSITION,
  decideWatched,
  isWatchedByRule,
  RECENT_LIMIT,
} from "./rules";
export {
  type ContinueWatchingEntry,
  LibraryError,
  type LibraryErrorCode,
  type LibraryLogger,
  type LibraryStore,
  type ProgressEntry,
  type RecordTorrentInput,
  type SaveProgressInput,
  type TorrentEntry,
  type TorrentEntryWithMetadata,
} from "./types";
