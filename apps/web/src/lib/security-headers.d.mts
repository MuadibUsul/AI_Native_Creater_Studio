export declare function securityHeaders(options: { production: boolean; extraOrigins: readonly string[] }): { key: string; value: string }[];
export declare function parseExtraOrigins(raw: string | undefined): string[];
