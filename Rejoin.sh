#!/bin/bash

# --- KONFIGURASI WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}   ROBLOX AUTO-LAUNCHER V3 (LITE)      ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- AUTO DETECT SEMUA PACKAGE ---
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Aplikasi Roblox tidak ditemukan!${NC}"
    exit 1
fi

echo -e "Ditemukan ${#ALL_PACKAGES[@]} aplikasi."
echo -e "Jalankan semua secara otomatis..."

read -p "Masukkan Link Private Server (Kosongkan jika Publik): " PRIV_LINK
if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID: " GAME_ID
    IS_PRIVATE=false
else
    GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
    CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')
    IS_PRIVATE=true
fi

# --- SETTING LAYAR ---
# Paksa landscape sekali saja di awal biar nggak berat
su -c "settings put system accelerometer_rotation 0"
su -c "settings put system user_rotation 1"

# Ukuran Jendela
WIDTH=500
HEIGHT=350
POS_Y=80

rejoin() {
    local PKG=$1
    local INDEX=$2
    local POS_X=$(( INDEX * 520 )) # Jarak antar jendela
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Yellow}STARTING${NC} - $PKG"
    
    # Tutup aplikasi
    su -c "am force-stop $PKG"
    sleep 1

    # Tentukan Link
    if [ "$IS_PRIVATE" = true ]; then
        D_LINK="roblox://placeId=$GAME_ID&linkCode=$CODE"
    else
        D_LINK="roblox://placeId=$GAME_ID"
    fi

    # PERINTAH UTAMA: Langsung buka dalam mode Freeform (Windowing Mode 5)
    # Kita pakai 'am start-activity' agar lebih stabil di Android 10
    su -c "am start -n $PKG/com.roblox.client.MainActivity -a android.intent.action.VIEW -d '$D_LINK' --windowingMode 5 --task-bounds $POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    
    # Jeda 10 detik antar akun biar RAM nggak kaget/nge-freeze
    sleep 10
}

# --- LOOP UTAMA ---
while true; do
    for idx in "${!ALL_PACKAGES[@]}"; do
        CURRENT_PKG="${ALL_PACKAGES[$idx]}"
        
        # Cek apakah sedang jalan (pakai cara paling ringan)
        RUNNING=$(pgrep -f $CURRENT_PKG)
        
        if [ -z "$RUNNING" ]; then
            rejoin "$CURRENT_PKG" "$idx"
        fi
    done
    echo -ne "\r[*] Menunggu pengecekan ulang... "
    sleep 20
done
