/**
 * Server configuration constants
 */
export const SERVER_NAME = "pdf-generator-api";
export const SERVER_VERSION = "5.0.0";
export const API_BASE_URL = process.env.API_BASE_URL || "https://us1.pdfgeneratorapi.com/api/v4";
/** The template builder is not published on the public API host, so it is reached in-cluster by service name. */
export const BUILDER_BASE_URL = process.env.BUILDER_BASE_URL || "http://pdf-api-main/api/mcp/builder";
