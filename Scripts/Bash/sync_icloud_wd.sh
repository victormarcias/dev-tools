#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  _sync_icloud_wd.sh — VERSIÓN 2.3
#  Copia incremental de respaldo iCloud Drive → disco externo (NO espejo).
#  Nunca borra nada en el destino. Las versiones que se sobrescriben se
#  guardan en "_versiones_sobrescritas_<fecha>" (solo si hubo alguna).
#  La descarga de archivos "dataless" de iCloud la administra macOS.
#
#  Config: sync-config.txt junto al script (no se commitea; ver
#  sync-config.example.txt). Define ICLOUD, VOLUME y las carpetas (FOLDER=).
#
#  Uso:
#    ./_sync_icloud_wd.sh             # simulación (por defecto)
#    ./_sync_icloud_wd.sh --no-dry    # real
#  (también funciona con `sh` o `bash` delante, o con DRY_RUN=0 en el entorno)
#
#  Historial de versiones: ver el final del archivo (versión 1 comentada).
# ═══════════════════════════════════════════════════════════════════════
# Si lo corrieron con `sh`, relanzar con bash (usa sintaxis de bash)
if [ -z "${BASH_VERSION:-}" ] || shopt -oq posix 2>/dev/null; then
    exec env -u POSIXLY_CORRECT bash "$0" "$@"
fi

set -uo pipefail   # sin -e: los errores por carpeta se cuentan y se resumen

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
FOLDERS=()   # carpetas a sincronizar
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
OVERWRITTEN="$VOLUME/_versiones_sobrescritas_$STAMP"   # se crea solo si hace falta
LOG_DIR="$VOLUME/_logs_sync"
LOG="$LOG_DIR/sync_$STAMP.log"

# DRY_RUN=1 -> solo simula (default, por seguridad). DRY_RUN=0 -> ejecuta de verdad.
# Se cambia con --no-dry / --dry (o con la variable de entorno DRY_RUN).
DRY_RUN="${DRY_RUN:-1}"
for arg in "$@"; do
    case "$arg" in
        --no-dry) DRY_RUN=0 ;;
        --dry)    DRY_RUN=1 ;;
        *) printf "Opción desconocida: %s (usá --dry o --no-dry)\n" "$arg" >&2; exit 2 ;;
    esac
done

# Usar openrsync (el de macOS) solo si lo autorizás explícitamente.
ALLOW_OPENRSYNC="${ALLOW_OPENRSYNC:-0}"

# ── Elegir rsync ─────────────────────────────────────────
RSYNC=""
for c in /opt/homebrew/bin/rsync /usr/local/bin/rsync; do
    [ -x "$c" ] && RSYNC="$c" && break
done
[ -z "$RSYNC" ] && RSYNC="/usr/bin/rsync"
if "$RSYNC" --version 2>&1 | head -1 | grep -qi openrsync; then
    [ "$ALLOW_OPENRSYNC" = "1" ] || die "Solo hay openrsync ($RSYNC). --backup-dir no es confiable ahí. Instalá con 'brew install rsync' (o corré con ALLOW_OPENRSYNC=1)."
fi

# ── Chequeos previos ─────────────────────────────────────
# 1) Disco realmente montado (no solo que exista el directorio)
mount | grep -qF " on $VOLUME (" || die "'$VOLUME' no está montado. Conectá el disco y reintentá."

# 2) Carpetas de origen
MISSING=()
for folder in "${FOLDERS[@]}"; do
    [ -d "$ICLOUD/$folder" ] || MISSING+=("$folder")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    die "No existen en iCloud: ${MISSING[*]}  (en $ICLOUD)"
fi

# 3) Sistema de archivos del destino → ajustar flags
FSTYPE=$(diskutil info "$VOLUME" 2>/dev/null | awk -F: '/Type \(Bundle\)/ {gsub(/ /,"",$2); print tolower($2)}')
case "$FSTYPE" in
    apfs|hfs)
        FS_FLAGS=(-a) ;;
    *)  # exFAT / NTFS / FAT: sin permisos/owner POSIX y mtime con granularidad de 2s
        FS_FLAGS=(-rt --modify-window=2) ;;
esac

# ── Log (pantalla + archivo, sin códigos de color en el archivo) ──
mkdir -p "$LOG_DIR" || die "No pude crear $LOG_DIR"
exec > >(tee >(sed $'s/\033\\[[0-9;]*m//g' >> "$LOG")) 2>&1

# ── Flags como ARRAY (para que sobrevivan los espacios en rutas) ──
FLAGS=(
    "${FS_FLAGS[@]}" -u -i
    --exclude='*.icloud'
    --exclude='.DS_Store'
    --exclude='._*'
)
if [ "$DRY_RUN" -eq 1 ]; then
    FLAGS+=(-n)
else
    mkdir -p "$DEST" || die "No pude crear $DEST"
fi

printf "\n"
printf "${BOLD}${CYAN}☁️   iCloud Drive → 💾 %s${NC}\n" "${VOLUME##*/}/Cloud"
printf "${CYAN}────────────────────────────────────────${NC}\n"
printf "🔧 rsync: %s (%s)\n" "$RSYNC" "$("$RSYNC" --version | head -1)"
printf "💽 Destino: %s (%s)\n" "$VOLUME" "${FSTYPE:-?}"
printf "📝 Log: %s\n" "$LOG"
if [ "$DRY_RUN" -eq 1 ]; then
    printf "${YELLOW}🔍  MODO SIMULACIÓN — no se va a tocar nada todavía${NC}\n"
else
    printf "${RED}⚠️   MODO REAL — se van a aplicar cambios de verdad${NC}\n"
    printf "${RED}🗄️   Versiones sobrescritas (si hay) en: %s${NC}\n" "$OVERWRITTEN"
fi
printf "\n"

TOTAL=${#FOLDERS[@]}
COUNT=0
FAILED=()
WARNED=()
N_NEW=0
N_UPD=0
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

for folder in "${FOLDERS[@]}"; do
    COUNT=$((COUNT + 1))
    printf "${BLUE}📁 [$COUNT/$TOTAL] Sincronizando: ${BOLD}%s${NC}\n" "$folder"

    RUN_FLAGS=("${FLAGS[@]}")
    [ "$DRY_RUN" -eq 0 ] && RUN_FLAGS+=(--backup "--backup-dir=$OVERWRITTEN/$folder")

    "$RSYNC" "${RUN_FLAGS[@]}" "$ICLOUD/$folder/" "$DEST/$folder/" 2>&1 | tee "$TMP"
    rc=${PIPESTATUS[0]}

    new=$(grep -c '^>f+++++++++' "$TMP" || true)
    upd=$(grep '^>f' "$TMP" | grep -vc '^>f+++++++++' || true)
    N_NEW=$((N_NEW + new)); N_UPD=$((N_UPD + upd))

    case "$rc" in
        0)  printf "${GREEN}   ✅ OK${NC} — %s nuevos, %s actualizados\n" "$new" "$upd" ;;
        24) printf "${YELLOW}   ⚠️  OK con aviso (archivos desaparecieron durante la copia)${NC} — %s nuevos, %s actualizados\n" "$new" "$upd"
            WARNED+=("$folder") ;;
        *)  printf "${RED}   ❌ Error sincronizando %s (rsync exit %s)${NC}\n" "$folder" "$rc"
            FAILED+=("$folder (exit $rc)") ;;
    esac
    printf "\n"
done

# Limpiar carpetas vacías de versiones sobrescritas (no dejar nada si no hubo)
if [ -d "$OVERWRITTEN" ]; then
    find "$OVERWRITTEN" -type d -empty -delete 2>/dev/null
fi
if [ -d "$OVERWRITTEN" ]; then
    OVER_MSG="🗄️  Versiones sobrescritas guardadas en: $OVERWRITTEN"
else
    OVER_MSG="🗄️  No hubo sobrescrituras (no se creó carpeta de versiones)"
fi

# ── Resumen ──────────────────────────────────────────────
printf "${CYAN}────────────────────────────────────────${NC}\n"
printf "📊 Resumen: %s carpetas, %s archivos nuevos, %s actualizados\n" "$TOTAL" "$N_NEW" "$N_UPD"
printf "%s\n" "$OVER_MSG"
[ ${#WARNED[@]} -gt 0 ] && printf "${YELLOW}⚠️  Con avisos: %s${NC}\n" "${WARNED[*]}"

if [ ${#FAILED[@]} -gt 0 ]; then
    printf "${RED}💥 Fallaron %s de %s carpetas: %s${NC}\n" "${#FAILED[@]}" "$TOTAL" "${FAILED[*]}"
    printf "📝 Log: %s\n\n" "$LOG"
    exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
    printf "${YELLOW}✨ Simulación terminada. Revisá arriba y si está todo bien, corré:${NC}\n"
    printf "${BOLD}   sh %s --no-dry${NC}\n" "$(basename "$0")"
else
    printf "${GREEN}🎉 Sincronización completa.${NC}\n"
fi
printf "📝 Log: %s\n\n" "$LOG"
exit 0


# ═══════════════════════════════════════════════════════════════════════
#  HISTORIAL (solo referencia, no se ejecuta: el script termina en `exit 0`)
#
#  VERSIÓN 2: agregó chequeo de montaje/orígenes, log en el disco, resumen
#  con exit code, carpeta de versiones sobrescritas, elección de rsync y
#  chequeo de espacio libre interno (umbral MIN_FREE_GB).
#  VERSIÓN 3: se quitó el chequeo de espacio libre interno; la descarga de
#  archivos "dataless" de iCloud la administra macOS.
#
#  VERSIÓN 1 (original)
#  Qué hacía: rsync -au de las 6 carpetas, con --backup/--backup-dir en
#  modo real y -n -v en simulación.
#  Problemas que motivaron la versión 2:
#   - No verificaba que el disco estuviera montado ni que existieran los
#     orígenes; si el disco no estaba, podía escribir en /Volumes/ local.
#   - Los errores por carpeta se imprimían pero el script siempre
#     terminaba con éxito y sin resumen.
#   - --exclude sin comillas (el shell podía expandir *.icloud); no
#     excluía ._*.
#   - Carpeta de backup "_borrados_" con nombre engañoso (rsync sin
#     --delete no borra; guarda versiones sobrescritas), y un único
#     --backup-dir para todas las carpetas.
#   - Sin log, sin chequeo de espacio libre interno y flags fijos sin
#     mirar el filesystem ni qué rsync había (openrsync desde macOS 15.4).
#
#  #!/bin/bash
#  set -euo pipefail
#
#  # ── Colores ──────────────────────────────────────────────
#  RED='\033[0;31m'
#  GREEN='\033[0;32m'
#  YELLOW='\033[1;33m'
#  BLUE='\033[0;34m'
#  CYAN='\033[0;36m'
#  BOLD='\033[1m'
#  NC='\033[0m' # No Color
#
#  # ── Configuración ────────────────────────────────────────
#  ICLOUD="<path to iCloud Drive>"
#  DEST="<volume>/Cloud"
#  BACKUP="<volume>/_borrados_$(date +%Y%m%d_%H%M%S)"
#
#  # Carpetas a sincronizar
#  FOLDERS=("Folder1" "Folder2")
#
#  # DRY_RUN=1 -> solo simula. DRY_RUN=0 -> ejecuta de verdad.
#  DRY_RUN=0
#
#  # ── Flags como ARRAY (clave para que sobrevivan los espacios en rutas) ──
#  FLAGS=(-au --exclude=*.icloud --exclude=.DS_Store)
#
#  printf "\n"
#  printf "${BOLD}${CYAN}☁️   iCloud Drive → 💾 <volume>/Cloud${NC}\n"
#  printf "${CYAN}────────────────────────────────────────${NC}\n"
#
#  if [ "$DRY_RUN" -eq 1 ]; then
#      FLAGS+=(-n -v)
#      printf "${YELLOW}🔍  MODO SIMULACIÓN — no se va a tocar nada todavía${NC}\n"
#  else
#      FLAGS+=(--backup "--backup-dir=$BACKUP")
#      printf "${RED}⚠️   MODO REAL — se van a aplicar cambios de verdad${NC}\n"
#      printf "${RED}🗄️   Backup de lo borrado en: %s${NC}\n" "$BACKUP"
#  fi
#  printf "\n"
#
#  TOTAL=${#FOLDERS[@]}
#  COUNT=0
#
#  for folder in "${FOLDERS[@]}"; do
#      COUNT=$((COUNT + 1))
#      printf "${BLUE}📁 [$COUNT/$TOTAL] Sincronizando: ${BOLD}%s${NC}\n" "$folder"
#
#      if rsync "${FLAGS[@]}" "$ICLOUD/$folder/" "$DEST/$folder/"; then
#          printf "${GREEN}   ✅ OK${NC}\n"
#      else
#          printf "${RED}   ❌ Error sincronizando %s${NC}\n" "$folder"
#      fi
#      printf "\n"
#  done
#
#  printf "${CYAN}────────────────────────────────────────${NC}\n"
#  if [ "$DRY_RUN" -eq 1 ]; then
#      printf "${YELLOW}✨ Simulación terminada. Revisá arriba y si está todo bien, poné DRY_RUN=0 y corré de nuevo.${NC}\n"
#  else
#      printf "${GREEN}🎉 Sincronización completa.${NC}\n"
#  fi
#  printf "\n"
