## api.franciscosolis.cl - Official API for franciscosolis.cl

This is the official API for franciscosolis.cl, it's a REST API that allows the site to work with users, databases, etc.

## How to contribute
> **NOTE:**
> This project is designed to work in unix systems. To work on windows just open the file scripts/init and run that docker command. (Yep, idk the windows format to run docker, if you're using WSL just run `scripts/init`) 
1. Clone the repo!
2. Run `scripts/init`
3. Copy .env.example to .env and edit it so it works for you.
4. Run `sail up -d`. Make sure to configure the [Shell Alias](https://laravel.com/docs/10.x/sail#configuring-a-shell-alias).
5. Run `sail art key:generate` to generate an app key.
6. Run `sail art migrate --seed` to migrate and populate the database.
