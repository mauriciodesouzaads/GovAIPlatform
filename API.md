# 📡 GovAI Platform — API Reference

Base URL: `http://localhost:3000`

---

## 🔓 Autenticação

### Login Admin (JWT)
```
POST /v1/admin/login
Content-Type: application/json
```
**Body:**
```json
{ "email": "admin@govai.com", "password": "admin" }
```
**Response 200:**
```json
{ "token": "eyJhbGciOiJIUzI1...", "message": "Login successful" }
```

> Use o token retornado no header `Authorization: Bearer <token>` em todas as rotas admin.

---

## 🧠 Execução de IA (API Key Auth)

### Executar Prompt
```
POST /v1/execute/:assistantId
Authorization: Bearer sk-govai-xxxxxxxxxxxxxxxx
Content-Type: application/json
```
**Body:**
```json
{ "message": "Qual é a política interna sobre home office?" }
```
**Response 200:**
```json
{
  "choices": [{ "message": { "content": "De acordo com o documento..." } }],
  "usage": { "prompt_tokens": 150, "completion_tokens": 200, "total_tokens": 350 },
  "_govai": {
    "traceId": "a1b2c3d4-...",
    "signature": "3fa8e2b1..."
  }
}
```
**Response 403 (Violação de Política):**
```json
{
  "error": "Bloqueado pela Política (OPA): Tentativa de Evasão de Regras",
  "traceId": "a1b2c3d4-..."
}
```

---

## 📊 Dashboard (JWT Auth)

### Métricas
```
GET /v1/admin/stats
Authorization: Bearer <jwt_token>
```
**Response 200:**
```json
{
  "total_assistants": 2,
  "total_executions": 15,
  "total_violations": 3,
  "total_tokens": 4292,
  "estimated_cost_usd": "0.0006",
  "usage_history": [
    { "name": "seg.", "requests": 120, "violations": 5 }
  ]
}
```

---

## 📜 Audit Logs (JWT Auth)

### Listar Logs (Paginado)
```
GET /v1/admin/logs?page=1&limit=10
Authorization: Bearer <jwt_token>
```
**Response 200:**
```json
{
  "logs": [
    {
      "id": "uuid",
      "action": "EXECUTION_SUCCESS",
      "metadata": { "input": "...", "output": "...", "usage": {}, "traceId": "..." },
      "signature": "hmac_sha256_hash",
      "created_at": "2026-03-02T18:00:00Z"
    }
  ],
  "pagination": { "total": 50, "page": 1, "pages": 5 }
}
```

---

## 🤖 Assistants (JWT Auth)

### Listar Assistentes
```
GET /v1/admin/assistants
Authorization: Bearer <jwt_token>
```

### Criar Assistente
```
POST /v1/admin/assistants
Authorization: Bearer <jwt_token>
Content-Type: application/json
```
**Body:**
```json
{ "name": "Análise Jurídica" }
```
**Response 201:**
```json
{ "id": "uuid", "name": "Análise Jurídica", "status": "draft", "created_at": "..." }
```

---

## 🔑 API Keys (JWT Auth)

### Listar Chaves
```
GET /v1/admin/api-keys
Authorization: Bearer <jwt_token>
```

### Gerar Nova Chave
```
POST /v1/admin/api-keys
Authorization: Bearer <jwt_token>
Content-Type: application/json
```
**Body:**
```json
{ "name": "Produção Mobile" }
```
**Response 201:**
```json
{
  "id": "uuid",
  "prefix": "sk-govai-abcd",
  "key": "sk-govai-abcdefgh12345678abcd1234",
  "warning": "Guarde esta chave! Ela não será exibida novamente.",
  "created_at": "..."
}
```

### Revogar Chave
```
DELETE /v1/admin/api-keys/:keyId
Authorization: Bearer <jwt_token>
```
**Response 200:**
```json
{ "message": "Chave revogada com sucesso." }
```

---

## 📚 RAG Knowledge Base (JWT Auth)

### Criar Base de Conhecimento
```
POST /v1/admin/assistants/:assistantId/knowledge
Authorization: Bearer <jwt_token>
Content-Type: application/json
```
**Body:**
```json
{ "name": "Base Jurídica 2024" }
```

### Upload de Documento (RAG Ingestion)
```
POST /v1/admin/knowledge/:kbId/documents
Authorization: Bearer <jwt_token>
Content-Type: application/json
```
**Body:**
```json
{
  "content": "O regulamento interno estabelece que todos os funcionários...",
  "title": "Regulamento Interno 2024"
}
```
**Response 201:**
```json
{
  "message": "Documento ingerido com sucesso. 3 chunks vetorizados.",
  "chunksStored": 3
}
```

---

## ❤️ Health Check

```
GET /health
```
**Response 200:**
```json
{ "status": "ok", "db": "connected" }
```

---

## ⚠️ Códigos de Erro

| Código | Significado |
|---|---|
| `401` | Token JWT inválido ou ausente |
| `403` | API Key inválida / Violação de política OPA |
| `400` | Input inválido (validação Zod) |
| `404` | Assistente não encontrado |
| `429` | Rate limit excedido |
| `500` | Erro interno do servidor |
| `502` | Falha na comunicação com o provedor de IA |
