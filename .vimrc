execute pathogen#infect()

syntax on
filetype plugin indent on

map <C-n> :NERDTreeToggle<CR>

"Omnicomplete improvements http://vim.wikia.com/wiki/Make_Vim_completion_popup_menu_work_just_like_in_an_IDE
:set completeopt=longest,menuone
:inoremap <expr> <CR> pumvisible() ? "\<C-y>" : "\<C-g>u\<CR>"
inoremap <expr> <C-n> pumvisible() ? '<C-n>' :
  \ '<C-n><C-r>=pumvisible() ? "\<lt>Down>" : ""<CR>'

inoremap <expr> <M-,> pumvisible() ? '<C-n>' :
  \ '<C-x><C-o><C-n><C-p><C-r>=pumvisible() ? "\<lt>Down>" : ""<CR>'

" Supertab
"let g:SuperTabDefaultCompletionType = "<c-x><c-o>"
let g:SuperTabDefaultCompletionType = "context"

set nocompatible "This fixes the problem where arrow keys do not function properly on some systems.
syntax on "Enables syntax highlighting for programming languages
set mouse=a "Allows you to click around the text editor with your mouse to move the cursor
set showmatch "Highlights matching brackets in programming languages
set autoindent "If you're indented, new lines will also be indented
set smartindent "Automatically indents lines after opening a bracket in programming languages
set backspace=2 "This makes the backspace key function like it does in other programs.
set tabstop=4 "How much space Vim gives to a tab
set number "Enables line numbering
set smarttab "Improves tabbing
set shiftwidth=4 "Assists code formatting
colorscheme darkblue  "Changes the color scheme. Change this to your liking. Lookin /usr/share/vim/vim61/colors/ for options.
"setlocal spell "Enables spell checking (CURRENTLY DISABLED because it's kinda annoying). Make sure to uncomment the next line if you use this.
"set spellfile=~/.vimwords.add "The location of the spellcheck dictionary. Uncomment this line if you uncomment the previous line.
set foldmethod=manual "Lets you hide sections of code
"--- The following commands make the navigation keys work like standard editors
imap <silent> <Down> <C-o>gj
imap <silent> <Up> <C-o>gk
nmap <silent> <Down> gj
nmap <silent> <Up> gk
"--- Ends navigation commands
"--- The following adds a sweet menu, press F4 to use it.
source $VIMRUNTIME/menu.vim
set wildmenu
set cpo-=<
set wcm=<C-Z>
map <F4> :emenu <C-Z>
"--- End sweet menu
