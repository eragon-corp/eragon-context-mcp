type ConfigEnvironment = Partial<Record<"ERAGON_GATEWAY_URL" | "ANTHROPIC_BASE_URL" | "ERAGON_API_KEY" | "ANTHROPIC_API_KEY", string>>;
export type ResolvedConfig = {
    ok: true;
    gatewayUrl: string;
    token: string;
} | {
    ok: false;
    error: string;
};
export declare function resolveConfig(argv: string[], environment?: ConfigEnvironment): ResolvedConfig;
export declare function main(argv?: string[]): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map