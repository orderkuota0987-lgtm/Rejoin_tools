#!/bin/bash

# --- KONFIGURASI WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}   ROBLOX MULTI-REJOIN LANDSCAPE V5    ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- AUTO DETECT SEMUA PACKAGE ---
echo -e "${B_Yellow}[1] Memindai semua clone roblox...${NC}"
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Tidak ada aplikasi Roblox/clone ditemukan!${NC}"
    exit 1
fi

echo -e "Ditemukan ${#ALL_PACKAGES[@]} aplikasi."
echo -e "1) Jalankan SEMUA aplikasi sekaligus"
echo -e "2) Pilih satu aplikasi saja"
read -p "Pilihan kamu (1-2): " RUN_MODE

TARGET_PACKAGES=()
if [ "$RUN_MODE" == "1" ]; then
    TARGET_PACKAGES=("${ALL_PACKAGES[@]}")
else
    echo -e "\nPilih nomor aplikasi:"
    for i in "${!ALL_PACKAGES[@]}"; do
        echo -e "  $((i+1)) ${ALL_PACKAGES[$i]}"
    done
    read -p "Masukkan nomor: " CHOSEN
    TARGET_PACKAGES=("${ALL_PACKAGES[$((CHOSEN-1))]}")
fi

# --- INPUT LINK SERVER ---
echo -e "\n${B_Yellow}[2] Informasi Server Game${NC}"
read -p "Masukkan Link Private Server (Kosongkan jika Publik): " PRIV_LINK

if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID: " GAME_ID
    DEEP_LINK="roblox://placeId=$GAME_ID"
    echo -e "${B_Yellow}[*] Mode: Server Publik${NC}"
else
    # FIX: Langsung pakai link mentah tanpa ekstrak regex yang sering gagal di format baru
    DEEP_LINK="$PRIV_LINK"
    echo -e "${B_Green}[+] Mode: Private Server Terdeteksi!${NC}"
fi

# --- KUNCI ROTASI KE LANDSCAPE ---
echo -e "\n${B_Cyan}[*] Menyiapkan Layar Landscape...${NC}"
su -c "settings put system accelerometer_rotation 0"
su -c "settings put system user_rotation 1"
su -c "wm set-user-rotation lock 1"

# --- UKURAN JENDELA LANDSCAPE (FIX: Lebar > Tinggi) ---
WIDTH=640
HEIGHT=360
POS_Y=60

rejoin_and_align() {
    local PKG=$1
    local INDEX=$2
    local POS_X=$(( INDEX * 660 )) # Jarak geser antar window landscape
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Yellow}REJOINING${NC} - Membuka $PKG..."
    
    # Force stop pakai tanda kutip biar ga error "Unknown id"
    su -c "am force-stop $PKG"
    sleep 2

    # Buka langsung ke posisi Floating Window Landscape
    su -c "am start -n $PKG/com.roblox.client.MainActivity -a android.intent.action.VIEW -d '$DEEP_LINK' --windowingMode 5 --task-bounds $POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    
    # Kasih jeda waktu loading biar sistem gak overload/stuck
    sleep 10
}

# --- MONITORING LOOP (REJOIN TOOLS) ---
echo -e "\n${B_Green}[+] Sistem Pemantau Multi-Window Aktif...${NC}"
echo -e "${B_Cyan}-----------------------------------------${NC}"

while true; do
    for idx in "${!TARGET_PACKAGES[@]}"; do
        CURRENT_PKG="${TARGET_PACKAGES[$idx]}"
        
        # Cek apakah aplikasi mati menggunakan pidof
        IS_RUNNING=$(su -c "pidof $CURRENT_PKG")
        
        if [ -z "$IS_RUNNING" ]; then
            rejoin_and_align "$CURRENT_PKG" "$idx"
        fi
    done
    # Jeda pengecekan loop biar termux ga spam perintah su (bikin stuck)
    sleep 10
done
