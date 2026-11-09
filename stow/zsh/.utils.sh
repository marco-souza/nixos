mcd() {
  mkdir "$1"
  cd "$1" || exit
}

# kill
tid() {
  pgrep -axi "$1" | grep -v 0:00.00 | awk '{ print $1 }' | uniq
}

ak() {
  id=$(tid "$1")
  kill -9 "$id"
}

# Workon (tmux)
workon() {
  destination=$1

  if [ ! -d "$destination" ]; then
    # Do not exists, set up a new project
    mkdir "$destination"

    # set up git
    cd "$destination" && git init && cd - || exit
  fi

  mise trust "$destination"

  tmux neww -c "$destination"
}

# Git
mug() {
  gl && gco "$1" && gl && gco - && gm -Xours "$1"
}

rug() {
  gl && gco "$1" && gl && gco - && grb "$1"
}

# Homelab functions
lab() {
  ssh -t marco@"${1:-homelab}" 'tmux new -A -s lab-session'
}
