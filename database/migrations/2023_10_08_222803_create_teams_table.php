<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class() extends Migration {
    public function up(): void {
        Schema::create('teams', function(Blueprint $table) {
            $table->ulid('id')->unique()->primary();
            $table->foreignUlid('user_id')->constrained();
            $table->string('name');
            $table->string('slug');
            $table->text('bio');
            $table->string('website')->nullable();
            $table->json('emails')->default('[]');
            $table->json('links')->default('[]');
            $table->softDeletes();
            $table->timestamps();
        });
    }

    public function down(): void {
        Schema::dropIfExists('teams');
    }
};
