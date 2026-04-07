# GovAI Platform — Guia Prático: Como Fazer Funcionar

## O que está acontecendo

As mudanças de código dos Sprints UI-1 e UI-2 **estão no repositório**. Eu verifiquei:
- `globals.css` tem o tema warm dark (#0C0F14, #141820, #252A38)
- `Sidebar.tsx` tem mobile collapse (mobileOpen, lg:hidden)
- `LayoutWrapper.tsx` tem hamburger button
- Catalog, Consultant, Organizations têm `overflow-auto`
- Dashboard, API Keys, Architect têm error handling
- Zero `bg-black` ou `bg-[#111]` nas páginas admin

**Mas se você não está vendo as mudanças, é porque:**
1. O container Docker está usando uma imagem antiga (cache)
2. Ou você está rodando `npm run dev` local sem ter feito `npm install` depois das mudanças
3. Ou o backend não está rodando e toda a UI mostra erros

---

## Passo a Passo para Funcionar (do zero)

### 1. Preparar o .env
```bash
cd /caminho/para/GovAIPlatform
cp .env.example .env
```

Editar `.env` e preencher **obrigatoriamente**:
```
GROQ_API_KEY=gsk_xxxx        # Obter em https://console.groq.com/keys (grátis)
```

Os demais valores default funcionam para desenvolvimento local.

### 2. Subir tudo com Docker (rebuild forçado)
```bash
# Parar tudo e limpar
docker compose down -v

# Reconstruir TODAS as imagens (ignora cache)
docker compose build --no-cache

# Subir
docker compose up -d

# Aguardar 2-3 minutos para todos os healthchecks passarem
docker compose ps
```

Resultado esperado: 6 serviços running/healthy:
- database ✅
- redis ✅  
- litellm ✅
- presidio ✅ (demora ~60s para iniciar)
- api ✅
- admin-ui ✅

### 3. Verificar
```bash
# Backend
curl http://localhost:3000/health

# Admin UI
curl -o /dev/null -s -w "%{http_code}" http://localhost:3001
# Deve retornar 200
```

### 4. Acessar
- **Admin UI:** http://localhost:3001
- **Login:** admin@orga.com / GovAI2026@Admin
- **API Key demo:** sk-govai-demo00000000000000000000

**Assistentes demo (após seed):**
- Assistente Jurídico: http://localhost:3001/chat/00000000-0000-0000-0002-000000000001?key=sk-govai-demo00000000000000000000
- FAQ Interno RH: http://localhost:3001/chat/00000000-0000-0000-0002-000000000002?key=sk-govai-demo00000000000000000000
- Análise de Crédito: http://localhost:3001/chat/00000000-0000-0000-0002-000000000003?key=sk-govai-demo00000000000000000000

---

## Se a UI ainda mostra visual antigo (preto puro)

Isso significa que o container `admin-ui` está usando imagem cached:

```bash
# Forçar rebuild SÓ da UI
docker compose build admin-ui --no-cache
docker compose up -d admin-ui
```

## Se quiser rodar localmente (sem Docker para a UI)

```bash
# Backend + infra via Docker
docker compose up -d database redis litellm presidio api

# UI local (dev mode com hot reload)
cd admin-ui
npm install        # IMPORTANTE: precisa rodar depois de mudanças
npm run dev        # Abre em http://localhost:3000
```

**Atenção:** no modo dev local, a UI roda em `:3000` e o backend também. Mude a porta:
```bash
npm run dev -- --port 3001
```

E configure `NEXT_PUBLIC_API_URL=http://localhost:3000` no terminal ou em `admin-ui/.env.local`.

---

## Diagnóstico Rápido de Erros Comuns

| Sintoma | Causa | Solução |
|---------|-------|---------|
| Tela branca / "Erro ao carregar" | Backend não está rodando | `docker compose up -d` |
| Login falha | Seed não rodou | `docker compose exec api bash scripts/seed.sh` |
| "Cannot connect to server" | .env não existe ou incompleto | `cp .env.example .env` e preencher |
| UI mostra preto puro (sem cores) | Imagem Docker cached | `docker compose build admin-ui --no-cache` |
| LLM não responde | GROQ_API_KEY não configurada | Editar .env com key válida |
| Presidio demora | Normal | Aguardar 60-90s no primeiro boot |
| 502 Bad Gateway | API ainda iniciando | Aguardar healthcheck (30-60s) |
| Tudo funciona mas visual é feio | Browser cache | Ctrl+Shift+R (hard refresh) |
