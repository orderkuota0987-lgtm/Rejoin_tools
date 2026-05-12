#!/bin/bash

# --- KONFIGURASI WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}   ROBLOX MULTI-AUTOMATION LANDSCAPE   ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- AUTO DETECT SEMUA PACKAGE ---
echo -e "${B_Yellow}[1] Memindai semua clone com.roblox.clien*...${NC}"
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
    echo -e "\nPilih aplikasi:"
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
    read -p "Masukkan Game ID (Place ID) Roblox: " GAME_ID
    IS_PRIVATE=false
else
    GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
    CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')
    IS_PRIVATE=true
fi

# --- UKURAN JENDELA MODE LANDSCAPE ---
WIDTH=500    # Ukuran lebar dibuat lebih besar agar proporsi landscape
HEIGHT=360   # Tinggi diperkecil
POS_Y=50     # Jarak dari atas layar

# --- FUNGSI UTAMA REJOIN DAN STRUKTUR POSITIONING ---
rejoin_and_align() {
    local PKG=$1
    local INDEX=$2
    
    # KUNCI LAYAR KE LANDSCAPE (Memaksa sistem Android masuk mode horizontal)
    # user_rotation 1 = Landscape standar (90 derajat miring)
    tsudo wm set-user-rotation 1
    sleep 0.5
    
    # HITUNG KOORDINAT OTOMATIS BERBARIS MENYAMPING DI MODE LANDSCAPE
    # Setiap jendela bergeser ke kanan sebesar 520 pixel (Width + Jeda 20px)
    local POS_X=$(( INDEX * 520 ))
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Red}OFFLINE${NC} - Menjalankan $PKG di posisi X:$POS_X (Locked Landscape)"
    
    tsudo am force-stop $PKG
    sleep 1

    # Memanggil Activity utama dalam format horizontal/landscape
    if [ "$IS_PRIVATE" = true ]; then
        tsudo am start -n "$PKG/com.roblox.client.MainActivity" \
            -a android.intent.action.VIEW \
            -d "roblox://placeId=$GAME_ID&linkCode=$CODE" \
            --windowingMode 5 \
            --task-bounds "$POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    else
        tsudo am start -n "$PKG/com.roblox.client.MainActivity" \
            -a android.intent.action.VIEW \
            -d "roblox://placeId=$GAME_ID" \
            --windowingMode 5 \
            --task-bounds "$POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    fi
}

# --- MONITORING LOOP ---
echo -e "\n${B_Green}[+] Sistem Auto-Monitor Aktif Berjalan...${NC}"
echo -e "${B_Cyan}---------------------------------------${NC}"

while true; do
    for idx in "${!TARGET_PACKAGES[@]}"; do
        CURRENT_PKG="${TARGET_PACKAGES[$idx]}"
        
        # Cek apakah aplikasi sedang aktif berjalan
        IS_RUNNING=$(tsudo pidof $CURRENT_PKG)
        
        if [ -z "$IS_RUNNING" ]; then
            rejoin_and_align "$CURRENT_PKG" "$idx"
            sleep 15 
        fi
    done
    sleep 10
done
