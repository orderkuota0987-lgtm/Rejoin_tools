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
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Tidak ada aplikasi Roblox ditemukan!${NC}"
    exit 1
fi

echo -e "Ditemukan ${#ALL_PACKAGES[@]} aplikasi."
echo -e "1) Jalankan SEMUA sekaligus"
echo -e "2) Pilih satu saja"
read -p "Pilihan (1-2): " RUN_MODE

TARGET_PACKAGES=()
if [ "$RUN_MODE" == "1" ]; then
    TARGET_PACKAGES=("${ALL_PACKAGES[@]}")
else
    echo -e "\nPilih nomor aplikasi:"
    for i in "${!ALL_PACKAGES[@]}"; do
        echo -e "  $((i+1)) ${ALL_PACKAGES[$i]}"
    done
    read -p "Nomor: " CHOSEN
    TARGET_PACKAGES=("${ALL_PACKAGES[$((CHOSEN-1))]}")
fi

read -p "Masukkan Link Private Server (Kosongkan jika Publik): " PRIV_LINK
if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID: " GAME_ID
    IS_PRIVATE=false
else
    GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
    CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')
    IS_PRIVATE=true
fi

# --- PAKSA SISTEM KE LANDSCAPE ---
echo -e "\n${B_Yellow}[*] Mengunci Layar ke Landscape...${NC}"
su -c "settings put system accelerometer_rotation 0"
su -c "settings put system user_rotation 1"

# --- POSISI WINDOW ---
WIDTH=520
HEIGHT=360
POS_Y=100

rejoin_and_align() {
    local PKG=$1
    local INDEX=$2
    local POS_X=$(( INDEX * 540 ))
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Yellow}LAUNCHING${NC} - $PKG..."
    
    # Matikan aplikasi agar refresh
    su -c "am force-stop $PKG"
    sleep 1

    # Siapkan Deep Link
    if [ "$IS_PRIVATE" = true ]; then
        D_LINK="roblox://placeId=$GAME_ID&linkCode=$CODE"
    else
        D_LINK="roblox://placeId=$GAME_ID"
    fi

    # STEP 1: Buka secara NORMAL (Fullscreen) dulu biar PASTI MUNCUL di layar
    su -c "am start -a android.intent.action.VIEW -d '$D_LINK' $PKG" > /dev/null 2>&1
    
    # Tunggu 7 detik agar game loading dan muncul di layar
    sleep 7

    # STEP 2: Cari Task ID (Identitas jendela) yang baru dibuka
    local TASK_ID=$(su -c "dumpsys activity activities | grep -B 1 $PKG | grep 'TaskRecord' | head -n 1 | grep -oP ' #\K[0-9]+'")
    
    if [ -z "$TASK_ID" ]; then
        TASK_ID=$(su -c "am stack list | grep $PKG | grep -oP 'taskId=\K[0-9]+' | head -n 1")
    fi

    # STEP 3: Paksa jendelanya mengecil dan geser ke posisi Landscape
    if [ ! -z "$TASK_ID" ]; then
        echo -e "[$(date +%T)] ${B_Green}RESIZING${NC} - Menata Window $TASK_ID ke X:$POS_X"
        su -c "am stack move-task $TASK_ID 5 true" > /dev/null 2>&1
        su -c "am resize-task $TASK_ID $POS_X $POS_Y $END_X $END_Y" > /dev/null 2>&1
    else
        # Jika metode deteksi ID gagal, gunakan metode paksa langsung sebagai cadangan
        su -c "am start -n $PKG/com.roblox.client.MainActivity -a android.intent.action.VIEW -d '$D_LINK' --windowingMode 5 --task-bounds $POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    fi
}

# --- MONITORING LOOP ---
echo -e "\n${B_Green}[+] Sistem Pemantau Aktif...${NC}"

while true; do
    for idx in "${!TARGET_PACKAGES[@]}"; do
        CURRENT_PKG="${TARGET_PACKAGES[$idx]}"
        IS_RUNNING=$(su -c "pidof $CURRENT_PKG")
        if [ -z "$IS_RUNNING" ]; then
            rejoin_and_align "$CURRENT_PKG" "$idx"
            sleep 5
        fi
    done
    sleep 15
done
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
