alias free="free -m"

alias aptitude="sudo aptitude"
alias update="sudo aptitude update"
alias upgrade="sudo aptitude upgrade"
alias install="sudo aptitude install"
alias remove="sudo aptitude remove"
alias untar="tar -xzvf"
alias gitlab-check="sudo -u gitlab -H bundle exec rake gitlab:check RAILS_ENV=production"

alias cp='cp -i'
alias mv='mv -i'
alias rm='rm -i'
alias ll='ls -alrth'

alias ..='cd ..'
alias ...='cd ..; cd ..'

export PS1='\[\033[0;35m\]\h\[\033[0;33m\] \w\[\033[00m\]: '
export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8
export LANGUAGE=en_US.UTF-8
