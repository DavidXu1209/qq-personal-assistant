on run argv
    set itemTitle to item 1 of argv
    set hasDue to item 2 of argv
    set dueYear to (item 3 of argv) as integer
    set dueMonth to (item 4 of argv) as integer
    set dueDay to (item 5 of argv) as integer
    set dueHour to (item 6 of argv) as integer
    set dueMinute to (item 7 of argv) as integer
    set dueSecond to (item 8 of argv) as integer
    set noteText to item 9 of argv
    set markerText to item 10 of argv
    set sourceName to item 11 of argv
    set sourceId to item 12 of argv
    set provenance to markerText & linefeed & "来源群：" & sourceName & " (" & sourceId & ")"
    if noteText is "" then
        set fullBody to provenance
    else
        set fullBody to noteText & linefeed & linefeed & provenance
    end if

    tell application "Reminders"
        if not (exists list "待办") then error "找不到提醒事项列表“待办”"
        set targetList to list "待办"
        -- Reminders 对大列表执行 `whose body contains ...` 会非常慢，甚至超过
        -- 网关的 180 秒超时。动作标题是本系统的稳定幂等字段，先用原生的精确
        -- 标题索引缩小候选，再只读取少量候选的 body 校验 marker。
        set titleMatches to every reminder of targetList whose name is itemTitle
        set markerMatches to {}
        repeat with candidateReminder in titleMatches
            try
                if (body of candidateReminder) contains markerText then set end of markerMatches to candidateReminder
            end try
        end repeat
        set markerCount to count of markerMatches
        if markerCount is greater than 1 then error "提醒事项列表“待办”中存在重复的网关事项"

        if markerCount is 1 then
            set targetReminder to item 1 of markerMatches
        else
            if (count of titleMatches) is 1 then
                set targetReminder to item 1 of titleMatches
            else if (count of titleMatches) is greater than 1 then
                error "提醒事项列表“待办”中存在多个同名事项，无法安全去重"
            else
                if hasDue is "1" then
                    set dueValue to current date
                    set day of dueValue to 1
                    set year of dueValue to dueYear
                    set month of dueValue to dueMonth
                    set day of dueValue to dueDay
                    set time of dueValue to dueHour * hours + dueMinute * minutes + dueSecond
                    set targetReminder to make new reminder at end of reminders of targetList with properties {name:itemTitle, body:fullBody, due date:dueValue}
                else
                    set targetReminder to make new reminder at end of reminders of targetList with properties {name:itemTitle, body:fullBody}
                end if
            end if
        end if

        set name of targetReminder to itemTitle
        set body of targetReminder to fullBody
        set flagged of targetReminder to true
        if hasDue is "1" then
            set dueValue to current date
            set day of dueValue to 1
            set year of dueValue to dueYear
            set month of dueValue to dueMonth
            set day of dueValue to dueDay
            set time of dueValue to dueHour * hours + dueMinute * minutes + dueSecond
            set due date of targetReminder to dueValue
        end if

        set verifiedCandidates to every reminder of targetList whose name is itemTitle
        set verifiedMatches to {}
        repeat with candidateReminder in verifiedCandidates
            try
                if (body of candidateReminder) contains markerText then set end of verifiedMatches to candidateReminder
            end try
        end repeat
        if (count of verifiedMatches) is not 1 then error "提醒事项写入后校验失败"
        set verifiedReminder to item 1 of verifiedMatches
        if (name of verifiedReminder) is not itemTitle then error "提醒事项标题校验失败"
        if (flagged of verifiedReminder) is not true then error "提醒事项旗标校验失败"
        return id of verifiedReminder
    end tell
end run
