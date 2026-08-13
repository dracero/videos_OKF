#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Script de Verificación de Calidad — videos_OKF
# Ubicación: .agents/verify.sh
# Se ejecuta automáticamente en git push o manualmente con:
#   npm run verify
# ═══════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

WARNINGS=0
ERRORS=0

if [ "$SKIP_AGENTS_CHECK" = "1" ]; then
  echo -e "${YELLOW}⚠️  AGENTS.md checks bypassed (SKIP_AGENTS_CHECK=1)${NC}"
  exit 0
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  🔍 AGENTS.md Pre-Push Verification — videos_OKF           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ─── CHECK 1: Secrets en código fuente (§4.1) ─── SEVERIDAD: ALTA ───
echo -e "${BOLD}[1/8] Buscando secrets hardcodeados en src/...${NC}"
SECRETS=$(grep -rn "AIza[A-Za-z0-9_-]\{30\}\|sk-[A-Za-z0-9]\{20\}\|ghp_[A-Za-z0-9]\{36\}\|AKIA[A-Z0-9]\{16\}" src/ --include="*.js" --include="*.astro" --include="*.ts" 2>/dev/null || true)
if [ -n "$SECRETS" ]; then
  echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║ 🚫 BLOQUEADO: Secrets detectados en código fuente          ║${NC}"
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${RED}║ Severidad: ALTA                                             ║${NC}"
  echo -e "${RED}║ Regla:     AGENTS.md §3.3, §4.1                            ║${NC}"
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo "$SECRETS" | while read -r line; do
    echo -e "${RED}║  $line${NC}"
  done
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${RED}║ Push BLOQUEADO. Elimine los secrets antes de hacer push.    ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✅ No se encontraron secrets hardcodeados${NC}"
fi

# ─── CHECK 2: .env trackeado en git (§3.3) ─── SEVERIDAD: ALTA ───
echo -e "${BOLD}[2/8] Verificando que .env no esté trackeado...${NC}"
if git ls-files --error-unmatch .env 2>/dev/null 1>/dev/null; then
  echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║ 🚫 BLOQUEADO: .env está trackeado en Git                   ║${NC}"
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${RED}║ Severidad: ALTA                                             ║${NC}"
  echo -e "${RED}║ Fix:       git rm --cached .env                             ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✅ .env no está trackeado${NC}"
fi

# ─── CHECK 3: Console.log con datos sensibles (§3.3) ─── SEVERIDAD: MEDIA ───
echo -e "${BOLD}[3/8] Buscando console.log con datos sensibles...${NC}"
SENSITIVE_LOGS=$(grep -rn "console\.log.*apiKey\|console\.log.*API_KEY\|console\.log.*token\|console\.log.*secret" src/ --include="*.js" --include="*.ts" 2>/dev/null || true)
if [ -n "$SENSITIVE_LOGS" ]; then
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║ ⚠️  ADVERTENCIA: Console.log con datos sensibles            ║${NC}"
  echo -e "${YELLOW}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${YELLOW}║ Severidad: MEDIA                                             ║${NC}"
  echo -e "${YELLOW}║ Regla:     AGENTS.md §3.3                                    ║${NC}"
  echo -e "${YELLOW}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo "$SENSITIVE_LOGS" | while read -r line; do
    echo -e "${YELLOW}║  $line${NC}"
  done
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✅ No se encontraron logs de datos sensibles${NC}"
fi

# ─── CHECK 4: find()/filter() dentro de loops (§2.1) ─── SEVERIDAD: MEDIA ───
echo -e "${BOLD}[4/8] Buscando find()/filter() dentro de map/forEach/for (complejidad)...${NC}"
FIND_IN_LOOPS=$(grep -n "\.find\|\.filter" src/pages/api/semantic-search.js 2>/dev/null || true)
FIND_COUNT=$(echo "$FIND_IN_LOOPS" | grep -c "find\|filter" 2>/dev/null || echo "0")
if [ "$FIND_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║ ⚠️  ADVERTENCIA: Búsqueda lineal en loop (O(N×M))           ║${NC}"
  echo -e "${YELLOW}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${YELLOW}║ Archivo:   src/pages/api/semantic-search.js                  ║${NC}"
  echo -e "${YELLOW}║ Instancias: ${FIND_COUNT} usos de find()/filter()                       ║${NC}"
  echo -e "${YELLOW}║ Severidad: MEDIA                                             ║${NC}"
  echo -e "${YELLOW}║ Regla:     AGENTS.md §2.1                                    ║${NC}"
  echo -e "${YELLOW}║ Fix:       Convertir arrays a Map antes del loop             ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✅ No se detectaron búsquedas lineales en loops${NC}"
fi

# ─── CHECK 5: Race condition en Singleton (§1.4) ─── SEVERIDAD: MEDIA ───
echo -e "${BOLD}[5/8] Verificando singleton del modelo ML...${NC}"
RACE_COND=$(grep -n "if (!extractor)" src/lib/semantic-search.js 2>/dev/null || true)
if [ -n "$RACE_COND" ]; then
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║ ⚠️  ADVERTENCIA: Race condition en Singleton                ║${NC}"
  echo -e "${YELLOW}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${YELLOW}║ Archivo:   src/lib/semantic-search.js                        ║${NC}"
  echo -e "${YELLOW}║ Severidad: MEDIA                                             ║${NC}"
  echo -e "${YELLOW}║ Regla:     AGENTS.md §1.4                                    ║${NC}"
  echo -e "${YELLOW}║ Fix:       Almacenar Promise en vez del valor resuelto       ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✅ Singleton usa Promise (sin race condition)${NC}"
fi

# ─── CHECK 6: Normalización NFD duplicada (§1.7) ─── SEVERIDAD: BAJA ───
echo -e "${BOLD}[6/8] Buscando normalización NFD duplicada...${NC}"
NFD_COUNT=$(grep -c 'normalize("NFD")' src/lib/semantic-search.js 2>/dev/null || echo "0")
if [ "$NFD_COUNT" -gt 1 ]; then
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║ ⚠️  ADVERTENCIA: Normalización NFD duplicada ×${NFD_COUNT}              ║${NC}"
  echo -e "${YELLOW}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${YELLOW}║ Archivo:   src/lib/semantic-search.js                        ║${NC}"
  echo -e "${YELLOW}║ Severidad: BAJA                                              ║${NC}"
  echo -e "${YELLOW}║ Regla:     AGENTS.md §1.7                                    ║${NC}"
  echo -e "${YELLOW}║ Fix:       Extraer a función normalizeText() centralizada    ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✅ Normalización de texto centralizada${NC}"
fi

# ─── CHECK 7: Frontmatter escrito más de una vez (§1.3) ─── SEVERIDAD: MEDIA ───
echo -e "${BOLD}[7/8] Verificando escritura duplicada de frontmatter...${NC}"
DOUBLE_WRITE=$(grep -c "fs.writeFile.*videos.*\.md" src/lib/sync.js 2>/dev/null || echo "0")
if [ "$DOUBLE_WRITE" -gt 1 ]; then
  echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║ ⚠️  ADVERTENCIA: Frontmatter de video escrito ${DOUBLE_WRITE} veces       ║${NC}"
  echo -e "${YELLOW}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${YELLOW}║ Archivo:   src/lib/sync.js                                   ║${NC}"
  echo -e "${YELLOW}║ Severidad: MEDIA                                             ║${NC}"
  echo -e "${YELLOW}║ Regla:     AGENTS.md §1.3                                    ║${NC}"
  echo -e "${YELLOW}║ Fix:       Usar Builder para construir el frontmatter 1 vez  ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✅ Cada archivo de video se escribe una sola vez${NC}"
fi

# ─── CHECK 8: Build (§4.1) ─── SEVERIDAD: ALTA ───
echo -e "${BOLD}[8/8] Ejecutando npm run build...${NC}"
if npm run build --silent > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ Build exitoso${NC}"
else
  echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║ 🚫 BLOQUEADO: npm run build falló                          ║${NC}"
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${RED}║ Severidad: ALTA                                             ║${NC}"
  echo -e "${RED}║ Push BLOQUEADO hasta que el build pase sin errores.         ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─── RESUMEN ───
echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  RESUMEN: ${ERRORS} errores bloqueantes, ${WARNINGS} advertencias${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo -e "${RED}❌ Push BLOQUEADO por ${ERRORS} error(es) de severidad ALTA.${NC}"
  echo -e "${RED}   Corrija los errores antes de hacer push.${NC}"
  echo -e "${RED}   Para bypass de emergencia: SKIP_AGENTS_CHECK=1 git push${NC}"
  echo ""
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}⚠️  Hay ${WARNINGS} advertencia(s) pendiente(s) (ver arriba).${NC}"
  echo -e "${YELLOW}   El push continuará, pero considere corregirlas.${NC}"
  echo ""
fi

echo -e "${GREEN}✅ Push autorizado.${NC}"
echo ""
exit 0
