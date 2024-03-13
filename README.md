## api.franciscosolis.cl - Official API for franciscosolis.cl

This is the official API for franciscosolis.cl, it's a REST API that allows the site to work with users, databases, etc.

## How to contribute
> **NOTE:**
> This project is designed to work in unix systems. To work on windows just open the file scripts/init and run that docker command. (Yep, idk the windows format to run docker, if you're using WSL just run `scripts/init`)
1. Clone the repo!
2. Run `scripts/init`
3. Copy .env.example to .env and edit it so it works for you.
4. Run `sail up -d`. Make sure to configure the [Shell Alias](https://laravel.com/docs/sail#configuring-a-shell-alias).
5. Run `sail art key:generate` to generate an app key.
6. Run `sail art migrate --seed` to migrate and populate the database.

## Coding guidelines
This section contains the coding guidelines and general formatting admitted in our codebase.

<details><summary style="font-weight: bold;font-size: medium;">Model Classes</summary>

The order for model classes will be:
- `use` statements.
- `$fillable` array.
- `$hidden` array.
- `$casts` array.
- `$appends` array.
- `$with` array.
- `$withCount` array.
- `$timestamps` boolean.
- Relationships
- Scopes
- Accessors
- Mutators
- Custom methods

</details>

<details><summary style="font-weight: bold;font-size: medium;">HTTP Controllers</summary>

Our guidelines for the http controllers are the following:

#### Controller methods
A controller should always have the following methods:
- `index` - Returns a list of resources.
- `show` - Returns a single resource.
- `store` - Creates a new resource.
- `update` - Updates a resource.
- `destroy` - Deletes a resource.
- `restore` - Restores a resource.

> You can avoid some of these methods if you don't need them. But if there's a model that has that kind of action, for example, a team should always have `show`, `update` and `destroy` methods.

#### Controller method arguments
Usually when creating a controller the default argument is `Request $request`, you will remove it because we want to keep arguments as clean as possible.
The only arguments that should be in the controller methods are the ones that are needed to perform the action. For example, if you're updating a user account, you'll only need User. Or if you're inviting someone to a team
you'll need the Team and the User.

To access request information just use the method helper `request()`. There's no performance difference between using the helper and injecting the request.

Also, there's an exception to this rule, if you create a form request to validate the request, you can add it as an argument to the method.
</details>
