import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === 'production';

// unsafe-eval required by Next.js dev server (HMR/webpack), but must be
// removed in production to prevent XSS exploitation of eval().
const scriptSrc = isProduction
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const cspValue = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' " + (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'),
    "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    // Enforce CSP in production; report-only in development for easier debugging
    {
        key: isProduction ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
        value: cspValue,
    },
];

const nextConfig: NextConfig = {
    // Gera saída standalone para Docker otimizado (sem node_modules nem source no container final)
    output: 'standalone',

    async headers() {
        return [
            {
                // Aplica os headers de segurança em todas as rotas
                source: '/(.*)',
                headers: securityHeaders,
            },
        ];
    },
};

export default nextConfig;
