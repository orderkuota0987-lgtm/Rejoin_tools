#!/bin/bash

# --- WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}    ROBLOX LANDSCAPE AUTO-REJOIN V4    ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- SCAN APLIKASI ---
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Roblox tidak ditemukan!${NC}"
    exit 1
fi

echo -e "Ditemukan ${#ALL_PACKAGES[@]} aplikasi."
read -p "Masukkan Link Private Server: " PRIV_LINK

# --- EKSTRAK DATA LINK (FIX PRIVATE SERVER) ---
GAME_ID=$(echo "$PRIV_LINK" | grep -oP 'games/\K[0-9]+')
CODE=$(echo "$PRIV_LINK" | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')

if [ -z "$CODE" ]; then
    D_LINK="roblox://placeId=$GAME_ID"
    echo -e "${B_Yellow}[!] Mode: Server Publik${NC}"
else
    D_LINK="roblox://placeId=$GAME_ID&linkCode=$CODE"
    echo -e "${B_Green}[+] Mode: Private Server Terdeteksi!${NC}"
fi

# --- PAKSA LANDSCAPE (COMMAND KOMPLIT) ---
echo -e "${B_Yellow}[*] Mengunci Orientasi Landscape...${NC}"
su -c "settings put system accelerometer_rotation 0"
su -c "settings put system user_rotation 1"
su -c "wm set-user-rotation lock 1"

# --- SETTING WINDOW ---
WIDTH=550
HEIGHT=340
POS_Y=80

rejoin() {
    local PKG=$1
    local INDEX=$2
    local POS_X=$(( INDEX * 570 ))
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Cyan}MEMBUKA:${NC} $PKG (Window $((INDEX+1)))"
    
    # Matikan aplikasi (Wajib agar link private server fresh)
    su -c "am force-stop $PKG"
    sleep 1

    # JALANKAN DENGAN WINDOWING MODE 5 (FREEFORM)
    # Gunakan tanda kutip ganda pada D_LINK agar karakter '&' tidak mematikan script
    su -c "am start -n \"$PKG/com.roblox.client.MainActivity\" -a android.intent.action.VIEW -d \"$D_LINK\" --windowingMode 5 --task-bounds \"$POS_X,$POS_Y,$END_X,$END_Y\"" > /dev/null 2>&1
    
    # Tunggu 12 detik antar akun (Biar RAM UgPhone nggak kaget)
    echo -e "[*] Menunggu loading..."
    sleep 12
}

# --- JALANKAN LOOP ---
for idx in "${!ALL_PACKAGES[@]}"; do
    rejoin "${ALL_PACKAGES[$idx]}" "$idx"
done

echo -e "${B_Green}--- SEMUA SELESAI ---${NC}"
