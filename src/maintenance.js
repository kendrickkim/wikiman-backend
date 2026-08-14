let locked = false

export function isMaintenance() {
  return locked
}

export function beginMaintenance() {
  locked = true
}

export function endMaintenance() {
  locked = false
}
