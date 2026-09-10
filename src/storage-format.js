export const STORAGE_SCHEMA_VERSION = "1";
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIMENSION = 384;

export const STORAGE_METADATA = {
  schema_version: STORAGE_SCHEMA_VERSION,
  embedding_model: EMBEDDING_MODEL,
  embedding_dimension: String(EMBEDDING_DIMENSION),
};
