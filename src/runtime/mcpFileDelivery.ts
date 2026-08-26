/**
 * Text markers used by the stdio MCP subprocess and SemanticSessionRuntime to
 * distinguish a completed Gateway-local delivery from a route that was not
 * available. The ACP boundary only guarantees text tool results, so the marker
 * must survive provider-specific result shaping.
 */
export const MCP_RUNTIME_FILE_DELIVERY_HANDLED = 'malink-runtime-file-delivery:handled'
export const MCP_RUNTIME_FILE_DELIVERY_UNAVAILABLE = 'malink-runtime-file-delivery:unavailable'
