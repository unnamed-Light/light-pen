use super::*;

fn identifier(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}
fn date(value: &Value) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    let bytes = s.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = s[..4].parse().unwrap_or(0);
    let month: usize = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    if !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day > 0 && day <= days[month - 1]
}
pub fn validate(el: &Value, kind: &str, version: u32) -> Result<(), String> {
    if let Some(grid) = el.get("grid") {
        if kind != "table" || version < 4 {
            return Err("Для полей таблицы требуется формат 4.".into());
        }
        let cells = el
            .get("cells")
            .and_then(Value::as_array)
            .ok_or("Нет ячеек таблицы.")?;
        let rows = grid
            .get("rows")
            .and_then(Value::as_array)
            .filter(|r| r.len() == cells.len())
            .ok_or("Повреждены строки данных.")?;
        let columns = grid
            .get("columns")
            .and_then(Value::as_array)
            .filter(|c| c.len() == cells.first().and_then(Value::as_array).map_or(0, Vec::len))
            .ok_or("Повреждены поля данных.")?;
        let mut row_ids = HashSet::new();
        let mut col_ids = HashSet::new();
        for row in rows {
            if !identifier(row) || !row_ids.insert(row) {
                return Err("Повторяющаяся или повреждённая строка.".into());
            }
        }
        for col in columns {
            let id = col.get("id").ok_or("Нет идентификатора поля.")?;
            if !identifier(id)
                || !col_ids.insert(id)
                || col.get("type").and_then(Value::as_str).is_none_or(|s| {
                    !["text", "number", "date", "checkbox", "select", "url"].contains(&s)
                })
            {
                return Err("Повреждён тип поля.".into());
            }
            if let Some(options) = col.get("options") {
                let list = options
                    .as_array()
                    .filter(|v| v.len() <= 100)
                    .ok_or("Повреждены варианты поля.")?;
                let mut seen = HashSet::new();
                for value in list {
                    if value
                        .as_str()
                        .is_none_or(|v| v.encode_utf16().count() > 250)
                        || !seen.insert(value)
                    {
                        return Err("Повреждены варианты поля.".into());
                    }
                }
            }
        }
    }
    if kind == "task" {
        let task = el.get("task").ok_or("Нет данных задачи.")?;
        let keys = [
            "start",
            "description",
            "priority",
            "estimate",
            "tags",
            "dependencies",
            "archived",
        ];
        if version < 4 && keys.iter().any(|k| task.get(k).is_some()) {
            return Err("Для расширенной задачи требуется формат 4.".into());
        }
        if ["start", "due"]
            .iter()
            .any(|k| task.get(k).is_some_and(|v| !date(v)))
        {
            return Err("Повреждена дата задачи.".into());
        }
        if task.get("description").is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| s.encode_utf16().count() > 100_000)
        }) || task.get("priority").is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| !["none", "low", "normal", "high", "urgent"].contains(&s))
        }) || task.get("estimate").is_some_and(|v| {
            v.as_f64()
                .is_none_or(|n| !n.is_finite() || !(0.0..=1_000_000.0).contains(&n))
        }) || task.get("archived").is_some_and(|v| !v.is_boolean())
        {
            return Err("Повреждены поля задачи.".into());
        }
        for key in ["tags", "dependencies"] {
            if let Some(values) = task.get(key) {
                let list = values
                    .as_array()
                    .filter(|v| v.len() <= 1000)
                    .ok_or("Повреждён список задачи.")?;
                let mut ids = HashSet::new();
                for value in list {
                    let text = value
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Повреждено значение задачи.")?;
                    if !ids.insert(text)
                        || (key == "tags" && text.encode_utf16().count() > 100)
                        || (key == "dependencies"
                            && (text.len() > 128
                                || Some(text) == el.get("id").and_then(Value::as_str)))
                    {
                        return Err("Повреждено значение задачи.".into());
                    }
                }
            }
        }
        if task
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|i| {
                    i.get("id")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.len() > 128)
                })
            })
        {
            return Err("Повреждён идентификатор пункта.".into());
        }
    }
    Ok(())
}
