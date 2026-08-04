#! /usr/bin/env zsh

mcd() { mkdir $1; cd $1; }

# kill
tid() {
    ps -ax | grep -i $1 | grep -v 0:00.00 | awk '{ print $1 }' | uniq
}
ak() { kill -9 $(tid $1) }

# Workon (tmux)
workon() {
  destination=$1

  if [ ! -d $destination ]; then
    # Do not exists, set up a new project
    mkdir $destination;

    # set up git
    cd  $destination && git init && cd -;
  fi

  mise trust $destination

  tmux neww -c $destination
}

# Git
mug() { gl && gco $1 && gl && gco - && gm -Xours $1 }

rug() { gl && gco $1 && gl && gco - && grb $1 }
