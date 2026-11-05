#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  _cleanup_wd.sh — VERSIÓN 1.1
#  Detecta archivos que están en el WD pero ya no existen en iCloud
#  (los que borraste en iCloud) y los saca del WD.
#
#  Por seguridad NO los borra de verdad: los MUEVE a una carpeta de
#  cuarentena "_eliminados_<fecha>" en el WD. Cuando estés seguro, borrás
#  esa carpeta a mano.
#
#  Config: sync-config.txt junto al script (no se commitea; ver
#  sync-config.example.txt). Define ICLOUD, VOLUME y las carpetas (FOLDER=).
#
#  Uso:
#    sh _cleanup_wd.sh             # simulación: lista lo que sobra (por defecto)
#    sh _cleanup_wd.sh --no-dry    # real: mueve lo que sobra a cuarentena
# ═══════════════════════════════════════════════════════════════════════

# Si lo corrieron con `sh`, relanzar con bash (usa sintaxis de bash)
if [ -z "${BASH_VERSION:-}" ] || shopt -oq posix 2>/dev/null; then
    exec env -u POSIXLY_CORRECT bash "$0" "$@"
fi

set -uo pipefail

# ── Colores ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

die() { printf "${RED}❌ %s${NC}\n" "$*" >&2; exit 1; }

# ── Configuración ────────────────────────────────────────
# Las rutas y carpetas personales viven en sync-config.txt (junto al script),
# que NO se commitea. La plantilla es sync-config.example.txt.
# Se puede apuntar a otro archivo con SYNC_CONFIG=/ruta/al/archivo.txt
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${SYNC_CONFIG:-$SCRIPT_DIR/sync-config.txt}"
[ -f "$CONFIG" ] || die "Falta $CONFIG. Copiá sync-config.example.txt como sync-config.txt y completalo."

ICLOUD=""
VOLUME=""
FOLDERS=()
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    value="${value/#\~/$HOME}"
    case "$key" in
        ICLOUD) ICLOUD="$value" ;;
        VOLUME) VOLUME="$value" ;;
        FOLDER) FOLDERS+=("$value") ;;
        *) die "Clave desconocida '$key' en $CONFIG" ;;
    esac
done < "$CONFIG"
[ -n "$ICLOUD" ] || die "Falta ICLOUD en $CONFIG"
[ -n "$VOLUME" ] || die "Falta VOLUME en $CONFIG"
[ ${#FOLDERS[@]} -gt 0 ] || die "Falta al menos un FOLDER en $CONFIG"

DEST="$VOLUME/Cloud"
STAMP="$(date +%Y%m%d_%H%M%S)"
QUARANTINE="$VOLUME/_eliminados_$STAMP"   # se crea solo si hace falta
LOG_DIR="$VOLUME/_logs_sync"
LOG="$LOG_DIR/cleanup_$STAMP.log"

# DRY_RUN=1 -> solo lista (default). Se cambia con --no-dry / --dry.
DRY_RUN="${DRY_RUN:-1}"
for arg in "$@"; do
    case "$arg" in
        --no-dry) DRY_RUN=0 ;;
        --dry)    DRY_RUN=1 ;;
        *) printf "Opción desconocida: %s (usá --dry o --no-dry)\n" "$arg" >&2; exit 2 ;;
    esac
done

ALLOW_OPENRSYNC="${ALLOW_OPENRSYNC:-0}"

# ── Elegir rsync ─────────────────────────────────────────
RSYNC=""
for c in /opt/homebrew/bin/rsync /usr/local/bin/rsync; do
    [ -x "$c" ] && RSYNC="$c" && break
done
[ -z "$RSYNC" ] && RSYNC="/usr/bin/rsync"
if "$RSYNC" --version 2>&1 | head -1 | grep -qi openrsync; then
    [ "$ALLOW_OPENRSYNC" = "1" ] || die "Solo hay openrsync ($RSYNC). Instalá con 'brew install rsync' (o corré con ALLOW_OPENRSYNC=1)."
fi

# ── Chequeos previos ─────────────────────────────────────
mount | grep -qF " on $VOLUME (" || die "'$VOLUME' no está montado. Conectá el disco y reintentá."
[ -d "$DEST" ] || die "No existe $DEST"

MISSING=()
for folder in "${FOLDERS[@]}"; do
    [ -d "$ICLOUD/$folder" ] || MISSING+=("$folder")
done
[ ${#MISSING[@]} -eq 0 ] || die "No existen en iCloud: ${MISSING[*]}  (en $ICLOUD)"

# Protección: si una carpeta de origen está vacía (iCloud sin sincronizar,
# por ejemplo), TODO el destino parecería "sobrante". Abortar.
# Y si hay placeholders ".nombre.icloud", esos archivos existen en iCloud
# pero rsync no los ve con su nombre real: abortar para no marcarlos.
for folder in "${FOLDERS[@]}"; do
    [ -n "$(ls -A "$ICLOUD/$folder" 2>/dev/null)" ] \
        || die "'$folder' está vacía en iCloud. ¿iCloud sin sincronizar? Abortado para no marcar todo como sobrante."
    n=$(find "$ICLOUD/$folder" -name '*.icloud' 2>/dev/null | wc -l | tr -d ' ')
    [ "$n" -eq 0 ] \
        || die "'$folder' tiene $n placeholders *.icloud (archivos no descargados con nombre alterado). Esperá a que iCloud termine de sincronizar."
done

# ── Log (pantalla + archivo, sin códigos de color en el archivo) ──
mkdir -p "$LOG_DIR" || die "No pude crear $LOG_DIR"
exec > >(tee >(sed $'s/\033\\[[0-9;]*m//g' >> "$LOG")) 2>&1

# Solo borrar: --existing y --ignore-existing evitan cualquier copia.
FLAGS=(-r -i --delete --existing --ignore-existing
       --exclude='.DS_Store' --exclude='._*')
if [ "$DRY_RUN" -eq 1 ]; then
    FLAGS+=(-n)
fi

printf "\n"
printf "${BOLD}${CYAN}🧹 %s — archivos que ya no están en iCloud${NC}\n" "${VOLUME##*/}/Cloud"
printf "${CYAN}────────────────────────────────────────${NC}\n"
printf "🔧 rsync: %s (%s)\n" "$RSYNC" "$("$RSYNC" --version | head -1)"
printf "📝 Log: %s\n" "$LOG"
if [ "$DRY_RUN" -eq 1 ]; then
    printf "${YELLOW}🔍  MODO SIMULACIÓN — solo se listan los archivos que sobran${NC}\n"
else
    printf "${RED}⚠️   MODO REAL — lo que sobra se MUEVE a: %s${NC}\n" "$QUARANTINE"
    printf "${RED}    (no se borra definitivamente; eso lo hacés vos después)${NC}\n"
    printf "¿Seguro? Escribí 'si' para continuar: "
    read -r ans < /dev/tty
    [ "$ans" = "si" ] || die "Cancelado."
fi
printf "\n"

TOTAL=${#FOLDERS[@]}
COUNT=0
FAILED=()
N_DEL=0
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

for folder in "${FOLDERS[@]}"; do
    COUNT=$((COUNT + 1))
    printf "${BLUE}📁 [$COUNT/$TOTAL] Revisando: ${BOLD}%s${NC}\n" "$folder"

    RUN_FLAGS=("${FLAGS[@]}")
    [ "$DRY_RUN" -eq 0 ] && RUN_FLAGS+=(--backup "--backup-dir=$QUARANTINE/$folder")

    "$RSYNC" "${RUN_FLAGS[@]}" "$ICLOUD/$folder/" "$DEST/$folder/" 2>&1 | tee "$TMP"
    rc=${PIPESTATUS[0]}

    n=$(grep -c '^\*deleting' "$TMP" || true)
    N_DEL=$((N_DEL + n))

    case "$rc" in
        0|24) printf "${GREEN}   ✅ OK${NC} — %s sobrantes\n" "$n" ;;
        *)    printf "${RED}   ❌ Error en %s (rsync exit %s)${NC}\n" "$folder" "$rc"
              FAILED+=("$folder (exit $rc)") ;;
    esac
    printf "\n"
done

# Limpiar cuarentena vacía
if [ -d "$QUARANTINE" ]; then
    find "$QUARANTINE" -type d -empty -delete 2>/dev/null
fi

# ── Resumen ──────────────────────────────────────────────
printf "${CYAN}────────────────────────────────────────${NC}\n"
printf "📊 Resumen: %s carpetas revisadas, %s elementos sobrantes\n" "$TOTAL" "$N_DEL"

if [ ${#FAILED[@]} -gt 0 ]; then
    printf "${RED}💥 Fallaron %s de %s carpetas: %s${NC}\n" "${#FAILED[@]}" "$TOTAL" "${FAILED[*]}"
    printf "📝 Log: %s\n\n" "$LOG"
    exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$N_DEL" -gt 0 ]; then
        printf "${YELLOW}✨ Simulación terminada. Revisá la lista y si está todo bien, corré:${NC}\n"
        printf "${BOLD}   sh %s --no-dry${NC}\n" "$(basename "$0")"
    else
        printf "${GREEN}✨ No sobra nada: el WD coincide con iCloud.${NC}\n"
    fi
else
    if [ -d "$QUARANTINE" ]; then
        printf "${GREEN}🎉 Listo. Lo que sobraba está en: %s${NC}\n" "$QUARANTINE"
        printf "   Cuando estés seguro, borrá esa carpeta a mano.\n"
    else
        printf "${GREEN}🎉 No había nada para mover.${NC}\n"
    fi
fi
printf "📝 Log: %s\n\n" "$LOG"
exit 0
