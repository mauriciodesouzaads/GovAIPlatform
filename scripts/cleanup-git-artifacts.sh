#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Remove artefatos compilados e binários do tracking do git
# ============================================================================
# Execute este script UMA VEZ para limpar arquivos que foram acidentalmente
# comprometidos antes de serem adicionados ao .gitignore.
#
# O script NÃO deleta os arquivos localmente — apenas os remove do índice git
# (git rm --cached). Os arquivos continuam presentes no disco.
#
# Uso: bash scripts/cleanup-git-artifacts.sh
# ============================================================================

set -euo pipefail

echo "╔═══════════════════════════════════════════════════╗"
echo "║  GovAI — Limpeza de artefatos no tracking do git  ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# Verifica que estamos na raiz do repositório
if [ ! -f "package.json" ] || [ ! -d ".git" ]; then
    echo "❌ Execute este script na raiz do repositório GovAI."
    exit 1
fi

REMOVED=0

remove_from_git() {
    local pattern="$1"
    local description="$2"
    # Verifica se há arquivos rastreados correspondendo ao padrão
    local tracked
    tracked=$(git ls-files "$pattern" 2>/dev/null || true)
    if [ -n "$tracked" ]; then
        echo "▶ Removendo do índice: $description"
        echo "$tracked" | while read -r f; do
            echo "  - $f"
            git rm --cached "$f" 2>/dev/null || true
        done
        REMOVED=$((REMOVED + 1))
    else
        echo "⏭  Já limpo: $description"
    fi
}

# ─── Artefatos de build JavaScript ───────────────────────────────────────────
remove_from_git "dist/"    "dist/ (TypeScript compilado)"
remove_from_git ".next/"   ".next/ (Next.js build cache)"
remove_from_git "build/"   "build/"
remove_from_git "out/"     "out/"

# ─── Arquivos ZIP de auditoria ────────────────────────────────────────────────
# ZIPs podem conter snapshots com dados sensíveis — não devem ser versionados.
for zipfile in *.zip; do
    [ -f "$zipfile" ] || continue
    if git ls-files --error-unmatch "$zipfile" > /dev/null 2>&1; then
        echo "▶ Removendo ZIP do índice: $zipfile"
        git rm --cached "$zipfile" 2>/dev/null || true
        REMOVED=$((REMOVED + 1))
    fi
done

# ─── Relatórios e artefatos temporários ──────────────────────────────────────
remove_from_git "compliance_report.pdf"    "compliance_report.pdf"
remove_from_git "codigo_completo.txt"      "codigo_completo.txt"
remove_from_git "validador_ui.js"          "validador_ui.js"
remove_from_git "backups_test/"            "backups_test/"

echo ""
if [ "$REMOVED" -gt 0 ]; then
    echo "────────────────────────────────────────────────────"
    echo "✅ $REMOVED categorias removidas do índice."
    echo ""
    echo "Próximo passo: faça commit das remoções:"
    echo "  git commit -m 'chore: remove compiled artifacts and binaries from git tracking'"
    echo ""
    echo "⚠️  Os arquivos ainda existem localmente — apenas foram removidos do tracking."
else
    echo "✅ Repositório já está limpo. Nenhum artefato rastreado encontrado."
fi
