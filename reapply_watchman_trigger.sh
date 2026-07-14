#!/bin/bash

# Ensure Watchman service is running
# Used to lunch Backup
systemctl start watchman

# Reapply Watchman trigger
watchman -- trigger-del /root/ssl/tracking_5.7 backup_trigger
watchman -- trigger /root/ssl/tracking_5.7 "backup_trigger" '**/*.js' -- bash /root/ssl/tracking_5.7/backup_script.sh
