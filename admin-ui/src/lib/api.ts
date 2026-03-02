// Centralized API configuration
// In production, set NEXT_PUBLIC_API_URL in your .env.local or Docker env
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
