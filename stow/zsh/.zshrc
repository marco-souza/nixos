source $HOME/.utils.sh
source $HOME/.aliases

eval "$(mise activate)"

## OMZ setup
export ZSH="$HOME/.oh-my-zsh"
export ZSH_THEME="ys"

plugins=(
  git
  brew
  docker
  mise
  zsh-autosuggestions
  zsh-syntax-highlighting
)

# Load Oh My Zsh
[[ -d $ZSH ]] && source $ZSH/oh-my-zsh.sh
