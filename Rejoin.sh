#!/bin/bash

# --- WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}    ROBLOX AUTO-REJOIN (FIX LINK) V5   ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- SCAN APLIKASI ---
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Roblox tidak ditemukan!${NC}"
    exit 1
fi

read -p "Masukkan Link Private Server (Kosongkan jika mau pakai Game ID): " PRIV_LINK

# --- LOGIK LINK BARU (LANGSUNG TEMBAK) ---
if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID: " GAME_ID
    D_LINK="roblox://placeId=$GAME_ID"
else
    # Gunakan link HTTPS utuh format terbaru Roblox
    D_LINK="$PRIV_LINK"
    echo -e "${B_Green}[+] Menggunakan Link Private Server!${NC}"
fi

# --- PAKSA LANDSCAPE ---
su -c "settings put system accelerometer_rotation 0"
su -c "settings put system user_rotation 1"

WIDTH=550
HEIGHT=340
POS_Y=80

rejoin() {
    local PKG=$1
    local INDEX=$2
    local POS_X=$(( INDEX * 570 ))
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "\n[$(date +%T)] ${B_Cyan}MEMBUKA:${NC} $PKG"
    su -c "am force-stop $PKG"
    sleep 1

    # Tampilkan log asli sistem Android agar kita bisa lihat jika ada error
    echo -e "${B_Yellow}[*] Memproses link...${NC}"
    su -c "am start -n $PKG/com.roblox.client.MainActivity -a android.intent.action.VIEW -d '$D_LINK' --windowingMode 5 --task-bounds $POS_X,$POS_Y,$END_X,$END_Y"
    
    echo -e "[*] Menunggu loading..."
    sleep 10
}

for idx in "${!ALL_PACKAGES[@]}"; do
    rejoin "${ALL_PACKAGES[$idx]}" "$idx"
done

echo -e "\n${B_Green}--- SEMUA SELESAI ---${NC}"
